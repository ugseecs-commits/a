/**
 * Mantiq HTML5 Bridge Controller & UI Synchronizer
 *
 * Architecture (non-blocking backend):
 *   The WASM engine runs entirely inside a Web Worker (wasm/mantiq-worker.js).
 *   Heavy computation (ASTProver, Quine-McCluskey) never touches the main thread.
 *
 *   Latest-wins protocol: every write (setExpression, setSOP, etc.) gets a
 *   monotonically-increasing sequence number (_latestSeq). The worker includes
 *   that number in its snapshot reply. The main thread only applies a snapshot
 *   when its seq === _latestSeq — all older, stale snapshots are silently dropped.
 *
 *   Computed fields (kmap, truth table, circuit, verilog) are cleared immediately
 *   when a new expression is sent so no stale data is ever shown while the worker
 *   is still computing.
 */

// ── Web Worker bridge ─────────────────────────────────────────────────────────

/** Cached state — populated by the worker after every computation. */
const _state = {
    hasResult:        false,
    isAlwaysTrue:     false,
    isAlwaysFalse:    false,
    expression:       '',
    simplifiedExpr:   '',
    allSolutions:     '[]',
    qmSteps:          '',
    variables:        '[]',
    variableStates:   '{}',
    truthTableJSON:   '',
    kMapJSON:         '',
    circuitJSON:      '',
    verilogGate:      '',
    verilogDataflow:  '',
    addTestbench:     true,
    currentView:      0
};

/** Monotonically-increasing sequence counter for latest-wins. */
let _latestSeq = 0;

/** Pending promise map for request-response calls. */
const _pending = new Map();
let   _nextId  = 1;
let   _proofTimeout = null;

/**
 * Mirrors ExpressionProcessor::tryParseShorthand()'s regexes (kmapPattern,
 * shortPattern, shortPatternOnlyDC in ExpressionProcessor.cpp). Shorthand
 * input (m(...)/M(...)/KMAP(...)) is resolved entirely inside that function
 * and never reaches the ASTProver branch, so there is no algebraic-proof
 * narrative to produce for it — scheduling _runProofAndSnapshot for shorthand
 * would just recompute an identical snapshot.
 */
const _KMAP_CMD_RE          = /^\s*KMAP\s*\(([^)]+)\)\s*$/i;
const _SHORTHAND_RE         = /^\s*(?:[a-zA-Z0-9_,'\s]+:)?\s*[mM]\s*\([\d,\s]*\)(?:\s*[dD]\s*\([\d,\s]*\))?\s*$/;
const _SHORTHAND_DC_ONLY_RE = /^\s*(?:[a-zA-Z0-9_,'\s]+:)?\s*[dD]\s*\([\d,\s]*\)\s*$/;

function _isShorthandInput(expr) {
    return _KMAP_CMD_RE.test(expr) || _SHORTHAND_RE.test(expr) || _SHORTHAND_DC_ONLY_RE.test(expr);
}

/**
 * Mirrors the worker's VIEW_FIELDS map (mantiq-worker.js). Used to decide,
 * on a view switch, whether the field(s) that view needs were actually
 * included in the last snapshot — buildSnapshot() now only computes the
 * heavy fields for whichever view was active at the time of the write.
 */
const VIEW_FIELDS_JS = {
    0: ['circuitJSON'],                     // SIMULATION
    1: ['circuitJSON'],                     // CIRCUIT
    2: ['kMapJSON'],                        // KMAP
    3: ['truthTableJSON'],                  // TRUTHTABLE
    4: ['verilogGate', 'verilogDataflow'],  // VERILOG
    5: []                                   // SOLUTION
};

/** Heavy fields known-fresh for the current expression/result. Reset on every content-changing snapshot. */
const _freshFields = new Set();

/** Spawn the worker that hosts the WASM engine. */
const _worker = new Worker('wasm/mantiq-worker.js?v=1.2.0');

_worker.onmessage = function (event) {
    const msg = event.data;

    // WASM initialised
    if (msg.type === 'ready') {
        wasmReady = true;
        console.log('[Mantiq] WASM engine ready in worker.');
        if (window.onMantiqInit) window.onMantiqInit();
        return;
    }

    // State snapshot — only apply if this is from the LATEST request.
    // Stale snapshots (from superseded requests) are discarded entirely.
    if (msg.type === 'state-snapshot') {
        if (msg.seq === _latestSeq) {
            _applySnapshot(msg.snapshot);
            updateFrontend();
        }
        return;
    }

    // Regular request-response
    if (msg.id !== undefined) {
        const { resolve, reject } = _pending.get(msg.id) || {};
        _pending.delete(msg.id);
        if (msg.error) {
            console.error('[Mantiq Worker Error]:', msg.error);
            if (reject) reject(new Error(msg.error));
        } else {
            if (resolve) resolve(msg.result);
        }
    }
};

_worker.onerror = function (e) {
    console.error('[Mantiq] Worker system error:', e);
};

/** Apply a state snapshot from the worker to the local cache. */
function _applySnapshot(snap) {
    if (!snap) return;
    Object.assign(_state, snap);
    // computedFields lists which heavy fields (truthTableJSON/kMapJSON/circuitJSON/
    // verilogGate/verilogDataflow) this snapshot actually refreshed. A field left out
    // of the snapshot keeps whatever was cached before — it belongs to a different
    // view and wasn't recomputed. resetFreshness distinguishes two cases: a real
    // content change (setExpression/setSOP/setSelectedSolution/runProof) means every
    // previously-cached heavy field is now suspect except the one(s) just rebuilt, so
    // the freshness set is dropped and replaced. A non-content-changing snapshot
    // (toggleVariable, or backfilling a view's field on switch) can't have made any
    // other view's cached field stale, so it only ADDS to what's already fresh.
    if (Array.isArray(snap.computedFields)) {
        if (snap.resetFreshness !== false) {
            _freshFields.clear();
        }
        snap.computedFields.forEach(f => _freshFields.add(f));
    }
    if (snap.variableStates) {
        try { simInputStates = JSON.parse(snap.variableStates); } catch (_) {}
    }
}

/**
 * Clear all computed/derived fields immediately so stale values from the
 * previous expression are never shown while the worker is computing.
 */
function _clearComputedState() {
    _state.hasResult       = false;
    _state.isAlwaysTrue    = false;
    _state.isAlwaysFalse   = false;
    _state.simplifiedExpr  = '';
    _state.allSolutions    = '[]';
    _state.qmSteps         = '';
    _state.variables       = '[]';
    _state.variableStates  = '{}';
    _state.truthTableJSON  = '';
    _state.kMapJSON        = '';
    _state.circuitJSON     = '';
    _state.verilogGate     = '';
    _state.verilogDataflow = '';
}

/**
 * Fire an aggregate call to the worker.
 * Increments _latestSeq so any in-flight older computation is ignored when it
 * eventually replies. The seq is passed to the worker so it can also skip
 * building the snapshot if a newer request already arrived.
 */
function _workerWriteCall(fn, args, view) {
    const seq = ++_latestSeq;
    const id  = _nextId++;
    _pending.set(id, { resolve: () => {}, reject: () => {} });
    // buildSnapshot() in the worker only marshals the heavy field(s) that `view`
    // needs (defaults to whatever view is currently on screen) — no point paying
    // for KMap/TruthTable/Circuit/Verilog JSON on every keystroke if none of
    // those views are visible.
    _worker.postMessage({ id, fn, args: args || [], seq, view: view !== undefined ? view : _state.currentView, addTestbench: _state.addTestbench });
}

/** Fire a regular (non-snapshot) call to the worker. */
function _workerCall(fn, args) {
    return new Promise((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, { resolve, reject });
        _worker.postMessage({ id, fn, args: args || [] });
    });
}

/**
 * Drop-in replacement for Module.ccall() — reads synchronously from cache.
 * Write operations are forwarded to the worker asynchronously (latest-wins).
 */
const Module = {
    ccall(fn, returnType, argTypes, args) {
        switch (fn) {
            // ── Reads (instant from cache) ──────────────────────────────────
            case 'mantiq_hasResult':     return _state.hasResult     ? 1 : 0;
            case 'mantiq_isAlwaysTrue':  return _state.isAlwaysTrue  ? 1 : 0;
            case 'mantiq_isAlwaysFalse': return _state.isAlwaysFalse ? 1 : 0;
            case 'mantiq_getView':       return _state.currentView;
            case 'mantiq_isSyntaxValid': return 1;

            case 'mantiq_getExpression':     return _state.expression     || 0;
            case 'mantiq_getSimplifiedExpr': return _state.simplifiedExpr || 0;
            case 'mantiq_getAllSolutions':    return _state.allSolutions   || 0;
            case 'mantiq_getQMSteps':        return _state.qmSteps        || 0;
            case 'mantiq_getVariables':      return _state.variables       || 0;
            case 'mantiq_getVariableStates': return _state.variableStates  || 0;
            case 'mantiq_getTruthTableJSON': return _state.truthTableJSON  || 0;
            case 'mantiq_getKMapJSON':       return _state.kMapJSON        || 0;
            case 'mantiq_getCircuitJSON':    return _state.circuitJSON     || 0;
            case 'mantiq_getVerilogCode':    return (args && args[0]) ? _state.verilogGate : _state.verilogDataflow;

            // ── Writes (async, latest-wins) ─────────────────────────────────
            case 'mantiq_setExpression': {
                const expr = (args && args[0]) || '';
                _state.expression = expr;
                if (expr.trim() === '') {
                    _clearComputedState();
                }
                _workerWriteCall('_setExpressionAndSnapshot', [expr]);

                if (_proofTimeout) clearTimeout(_proofTimeout);
                if (expr.trim() !== '' && !_isShorthandInput(expr)) {
                    _proofTimeout = setTimeout(() => {
                        _workerWriteCall('_runProofAndSnapshot', []);
                    }, 400);
                }
                return undefined;
            }

            case 'mantiq_setSOP': {
                const sop = (args && args[0]) ? 1 : 0;
                _workerWriteCall('_setSopAndSnapshot', [sop]);
                if (_proofTimeout) clearTimeout(_proofTimeout);
                if (_state.expression.trim() !== '' && !_isShorthandInput(_state.expression)) {
                    _proofTimeout = setTimeout(() => {
                        _workerWriteCall('_runProofAndSnapshot', []);
                    }, 400);
                }
                return undefined;
            }

            case 'mantiq_setView': {
                const view = (args && args[0]) || 0;
                _state.currentView = view;
                _workerCall(fn, args);
                // The last snapshot only computed heavy fields for whichever view was
                // active at the time. If we're switching to a view whose field(s)
                // weren't included, backfill with a cheap single-purpose fetch — this
                // just re-serializes the already-processed result, no QM recompute.
                const needed = VIEW_FIELDS_JS[view] || [];
                if (_state.hasResult && needed.some(f => !_freshFields.has(f))) {
                    _workerWriteCall('_refreshViewFields', [], view);
                }
                return undefined;
            }

            case 'mantiq_setSelectedSolution': {
                const idx = (args && args[0]) || 0;
                _workerWriteCall('_setSelectedSolutionAndSnapshot', [idx]);
                if (_proofTimeout) clearTimeout(_proofTimeout);
                if (_state.expression.trim() !== '' && !_isShorthandInput(_state.expression)) {
                    _proofTimeout = setTimeout(() => {
                        _workerWriteCall('_runProofAndSnapshot', []);
                    }, 400);
                }
                return undefined;
            }

            case 'mantiq_toggleVariable':
                _workerWriteCall('_toggleVariableAndSnapshot', [args && args[0]]);
                return undefined;

            case 'mantiq_freeStr':
                return undefined; // No-op — strings come from JS cache

            default:
                _workerCall(fn, args);
                return undefined;
        }
    },
    UTF8ToString(val) {
        return (typeof val === 'string') ? val : '';
    }
};


// ── Global state ─────────────────────────────────────────────────────────────
let wasmReady = false;
let lastSimplifiedExpr = '';
let lastActiveView = -1;
let kmapViewMode = 'normal';
let simInputStates = {};
let panelsState = {
    orig: { x: 0, y: 0, scale: 1.0, fitScale: 1.0 },
    simp: { x: 0, y: 0, scale: 1.0, fitScale: 1.0 },
    simOrig: { x: 0, y: 0, scale: 1.0, fitScale: 1.0 },
    simSimp: { x: 0, y: 0, scale: 1.0, fitScale: 1.0 }
};

function _scrollIdFor(panelType) {
    if (panelType === 'orig') return 'original-circuit-scroll';
    if (panelType === 'simp') return 'simplified-circuit-scroll';
    if (panelType === 'simOrig') return 'original-sim-scroll';
    if (panelType === 'simSimp') return 'simplified-sim-scroll';
    return '';
}

// Per-panel cache of container/content metrics, populated once at the START
// of a gesture (mousedown/touchstart/wheel) and reused for every frame of
// that gesture, instead of calling getBoundingClientRect() on every single
// touchmove/wheel event. Repeatedly reading layout geometry while also
// writing style.transform every frame is classic layout-thrashing and was
// the main source of the pinch/drag lag — this caches the read so a gesture
// costs one layout read total, not one per frame.
let _metricsCache = {};

function _measureMetrics(panelType) {
    const scrollEl = document.getElementById(_scrollIdFor(panelType));
    const contentEl = scrollEl ? scrollEl.querySelector('.zoom-content-wrapper') : null;
    if (!scrollEl || !contentEl) return null;
    const containerRect = scrollEl.getBoundingClientRect();
    const m = {
        scrollEl, contentEl,
        cw: containerRect.width || 400,
        ch: containerRect.height || 300,
        w: parseFloat(contentEl.style.width) || 400,
        h: parseFloat(contentEl.style.height) || 300
    };
    _metricsCache[panelType] = m;
    return m;
}

// Call at the start of a drag/pinch/wheel gesture to cache metrics for its duration.
function _beginGesture(panelType) {
    return _measureMetrics(panelType);
}

// Call when a gesture ends so the next one measures fresh (handles resizes etc).
function _endGesture(panelType) {
    delete _metricsCache[panelType];
}

function _getMetrics(panelType) {
    return _metricsCache[panelType] || _measureMetrics(panelType);
}

/**
 * Clamp pan so content never leaves the container with dead space around it
 * beyond what the fit-to-container view already shows — the same rule real
 * photo viewers and map apps use: if the content is smaller than (or equal
 * to) the viewport at this scale, it's locked centered; only once you've
 * zoomed in past that point can you pan, and then only until the content's
 * edge reaches the container's edge.
 */
function _clampPan(state, cw, ch, w, h) {
    const scaledW = w * state.scale;
    const scaledH = h * state.scale;

    if (scaledW <= cw + 0.5) {
        state.x = (cw - scaledW) / 2;
    } else {
        state.x = Math.max(cw - scaledW, Math.min(0, state.x));
    }

    if (scaledH <= ch + 0.5) {
        state.y = (ch - scaledH) / 2;
    } else {
        state.y = Math.max(ch - scaledH, Math.min(0, state.y));
    }
}

function applyZoom(panelType, smooth = false) {
    const m = _getMetrics(panelType);
    if (!m) return;
    const state = panelsState[panelType];

    // Zoom-out limit: never smaller than the fit-to-container scale — that
    // view is already "as much of the circuit, as big as possible, fully
    // visible" by definition, so zooming out further would only add dead
    // space. This also means _clampPan's centered-lock branch above kicks in
    // exactly at that limit, so hitting the floor always settles centered.
    if (state.fitScale) {
        state.scale = Math.max(state.fitScale, state.scale);
    }

    _clampPan(state, m.cw, m.ch, m.w, m.h);

    m.contentEl.style.transition = smooth ? 'transform 0.15s ease-out' : 'none';
    // translate3d/scale3d (not translate/scale) is deliberate: this keeps the
    // element on a real GPU-composited layer on every single applied frame.
    // A 2D transform here can let WebKit fall back to stretching a cached
    // raster of the filtered gate shapes (plastic-3d/silkscreen) during
    // continuous pinch updates, which is what caused the blur.
    m.contentEl.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale3d(${state.scale}, ${state.scale}, 1)`;
}

/**
 * A composited layer (which scale3d/translate3d deliberately promotes onto,
 * see applyZoom above) is only rasterized by the browser occasionally, not
 * on every transform frame. Between rasterizations the GPU just stretches
 * the last cached bitmap of the SVG to match the current transform. That's
 * exactly what we want *during* an active drag/pinch (cheap, smooth), but
 * it means the element can be left showing a stretched, blurry bitmap once
 * the gesture ends and the transform stops changing, until something else
 * happens to force a repaint.
 *
 * Call this right after a zoom/pan gesture settles (pointerup, touchend,
 * wheel-zoom debounce, fullscreen open/close) to force the browser to drop
 * the cached bitmap and re-rasterize the SVG crisply at the final scale.
 */
function _forceCrispRepaint(el) {
    if (!el) return;
    const prevWillChange = el.style.willChange;
    el.style.willChange = 'auto';   // drop the promoted layer / cached raster
    void el.offsetHeight;           // flush layout (cheap, but transforms don't need this to repaint)

    // Demoting the layer only matters once the browser actually PAINTS in the
    // un-promoted state — offsetHeight only flushes layout, not paint. Without
    // waiting a real frame, the browser can defer that paint indefinitely until
    // something unrelated (e.g. a click anywhere else) forces a paint pass —
    // which is exactly the "blurry until I click a button" symptom. Two nested
    // rAFs guarantee a real paint happens in between before we re-promote.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            el.style.willChange = prevWillChange || 'transform';
        });
    });
}

// DOM Elements
const elements = {
    input: document.getElementById('expression-input'),
    syntaxErrorLine: document.getElementById('syntax-error-line'),
    sopPosPill: document.getElementById('sop-pos-pill'),
    themePill: document.getElementById('theme-pill'),
    resultRow: document.getElementById('result-row'),
    solutionsCarousel: document.getElementById('solutions-carousel'),
    errorFeedback: document.getElementById('error-feedback'),
    emptyState: document.getElementById('empty-state'),
    canvas: document.getElementById('canvas'),
    
    // Modals
    altPopup: document.getElementById('alt-popup'),
    altBody: document.getElementById('alt-body'),
    altClose: document.getElementById('alt-close'),
    
    // Nav
    navButtons: document.querySelectorAll('.nav-btn'),
    toastContainer: document.getElementById('toast-container'),
    kmapViewPill: document.getElementById('kmap-view-pill')
};

/**
 * queryWasmString — reads from JS-side state cache (never blocks).
 * Arguments are passed through for compatibility but ignored for cached fns.
 */
function queryWasmString(funcName, args = [], argTypes = []) {
    if (!wasmReady) return '';
    try {
        switch (funcName) {
            case 'mantiq_getExpression':     return _state.expression     || '';
            case 'mantiq_getSimplifiedExpr': return _state.simplifiedExpr || '';
            case 'mantiq_getAllSolutions':    return _state.allSolutions   || '[]';
            case 'mantiq_getQMSteps':        return _state.qmSteps        || '';
            case 'mantiq_getVariables':      return _state.variables       || '[]';
            case 'mantiq_getVariableStates': return _state.variableStates  || '{}';
            case 'mantiq_getTruthTableJSON': return _state.truthTableJSON  || '';
            case 'mantiq_getKMapJSON':       return _state.kMapJSON        || '';
            case 'mantiq_getCircuitJSON':    return _state.circuitJSON     || '';
            case 'mantiq_getVerilogCode':
                return (args && args[0]) ? _state.verilogGate : _state.verilogDataflow;
            default:
                return '';
        }
    } catch (e) {
        console.error(`[Mantiq] queryWasmString(${funcName}):`, e);
        return '';
    }
}

// Toast Notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '✨';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    
    toast.innerHTML = `<span>${icon}</span> <div>${message}</div>`;
    elements.toastContainer.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 50);
    
    // Dismiss
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Helper: Calculate gate depth of a circuit node
function getGateDepth(node) {
    if (!node) return 0;
    if (!node.isGate) return 0;
    let maxChildDepth = 0;
    if (node.children && node.children.length > 0) {
        maxChildDepth = Math.max(...node.children.map(getGateDepth));
    }
    return 1 + maxChildDepth;
}

// Check gate levels and update navigation state
function updateNavigationState() {
    if (!wasmReady) return;
    
    const btnSim = document.getElementById('btn-view-sim');
    const btnCircuit = document.getElementById('btn-view-circuit');
    if (!btnSim || !btnCircuit) return;
    
    const jsonStr = queryWasmString('mantiq_getCircuitJSON');
    if (!jsonStr) {
        btnSim.classList.remove('disabled');
        btnCircuit.classList.remove('disabled');
        btnSim.removeAttribute('title');
        btnCircuit.removeAttribute('title');
        return;
    }
    
    let circuitData;
    try {
        circuitData = JSON.parse(jsonStr);
    } catch(e) {
        return;
    }
    
    const origDepth = getGateDepth(circuitData.original);
    const simpDepth = getGateDepth(circuitData.simplified);
    
    const maxAllowedDepth = 99; // Set to 99 to effectively disable the limit for now
    const bothExceeded = (origDepth > maxAllowedDepth) && (simpDepth > maxAllowedDepth);
    
    if (bothExceeded) {
        btnSim.classList.add('disabled');
        btnCircuit.classList.add('disabled');
        
        const note = "Circuits exceed 99 levels of gates.";
        btnSim.title = note;
        btnCircuit.title = note;
        
        // If current active view is simulation (0) or circuit diagram (1), switch to K-map (2) or Verilog (4)
        const activeBtn = document.querySelector('.nav-btn.active');
        if (activeBtn) {
            const currentView = activeBtn.getAttribute('data-view');
            if (currentView === '0' || currentView === '1') {
                const kmapBtn = document.getElementById('btn-view-kmap');
                const verilogBtn = document.getElementById('btn-view-verilog');
                const targetBtn = kmapBtn || verilogBtn;
                if (targetBtn) {
                    targetBtn.click();
                }
            }
        }
    } else {
        btnSim.classList.remove('disabled');
        btnCircuit.classList.remove('disabled');
        btnSim.removeAttribute('title');
        btnCircuit.removeAttribute('title');
    }
}

// Diagnose why an expression failed to parse, for the error-state tooltip
// Diagnose why an expression failed to parse, for the error-state tooltip
function diagnoseExpressionError(expr) {
    if (!expr) return "";

    // 1. Parentheses Mismatch
    const openParen = (expr.match(/\(/g) || []).length;
    const closeParen = (expr.match(/\)/g) || []).length;
    if (openParen > closeParen) return "Missing closing parenthesis ')'.";
    if (closeParen > openParen) return "Extra closing parenthesis ')'.";

    // 2. Minterm / Don't Care Overlap Check
    const mMatch = expr.match(/[mM]\s*\(([\d,\s]+)\)/);
    const dMatch = expr.match(/[dD]\s*\(([\d,\s]+)\)/);
    if (mMatch && dMatch) {
        const mTerms = mMatch[1].split(',').map(s => s.trim()).filter(s => s !== '');
        const dTerms = dMatch[1].split(',').map(s => s.trim()).filter(s => s !== '');
        const overlap = mTerms.find(t => dTerms.includes(t));
        if (overlap !== undefined) return `Conflict: Term ${overlap} is in both minterms and don't cares.`;
    }

    // 3. Variable Limit Check (> 6 variables)
    let uniqueVars = new Set();
    const varPrefixMatch = expr.match(/^([a-zA-Z0-9_,'\s]+):/);
    if (varPrefixMatch) {
        // Shorthand format: "A,B,C: m(1)"
        uniqueVars = new Set(varPrefixMatch[1].match(/[a-zA-Z]/g) || []);
    } else if (!/[mMdD]\s*\(/.test(expr)) {
        // Algebraic format: Strip known keywords first
        const stripped = expr.replace(/XOR|KMAP|TRUE|FALSE/gi, '');
        uniqueVars = new Set(stripped.match(/[a-zA-Z]/g) || []);
    }
    if (uniqueVars.size > 6) return "Maximum 6 variables supported.";

    // 4. Operator Syntax Checks
    if (/[+\-*>^|&]\s*$/.test(expr)) return "Expression ends with an operator.";
    if (/^\s*[+\-*>^|&]/.test(expr)) return "Expression starts with an operator.";
    if (/[+\-*>^|&]\s*[+\-*>^|&]/.test(expr)) return "Consecutive operators detected.";

    return ""; // Return empty string if no explicit error found
}

// Sync WASM State with DOM Layout
function updateFrontend() {
    if (!wasmReady) return;

    const expr = elements.input.value.trim();
    
    elements.syntaxErrorLine.style.display = 'none';
    elements.errorFeedback.style.display = 'none';

    // 1. Run client-side syntax diagnosis
    const manualError = diagnoseExpressionError(expr);
    
    // 2. Check if WASM currently holds a valid result
    const wasmHasResult = Module.ccall('mantiq_hasResult', 'number', [], []) !== 0;
    
    // An expression is only fully valid if WASM has a result AND there are no manual syntax errors
    const hasResult = wasmHasResult && !manualError;

    if (hasResult) {
        elements.emptyState.style.display = 'none';
        elements.resultRow.style.display = 'flex';
        
        updateNavigationState();
        
function parseTermLitsJS(term) {
    const lits = [];
    const clean = term.replace(/[()]/g, '');
    const re = /([a-zA-Z0-9_]+)(['!]?)/g;
    let match;
    while ((match = re.exec(clean)) !== null) {
        lits.push({ var: match[1], comp: match[2] === "'" || match[2] === "!" });
    }
    return lits;
}

function compareSopTermsJS(a, b) {
    if (a === b) return 0;
    const litsA = parseTermLitsJS(a);
    const litsB = parseTermLitsJS(b);

    if (litsA.length !== litsB.length) {
        return litsA.length - litsB.length;
    }

    const minLen = Math.min(litsA.length, litsB.length);
    for (let i = 0; i < minLen; i++) {
        if (litsA[i].var !== litsB[i].var) {
            return litsA[i].var.localeCompare(litsB[i].var);
        }
        if (litsA[i].comp !== litsB[i].comp) {
            return litsA[i].comp ? 1 : -1;
        }
    }
    return a.localeCompare(b);
}

function sortLiteralsInSingleTermJS(term) {
    const lits = parseTermLitsJS(term);
    if (lits.length === 0) return term;
    lits.sort((a, b) => {
        if (a.var !== b.var) return a.var.localeCompare(b.var);
        return a.comp === b.comp ? 0 : (a.comp ? 1 : -1);
    });
    const hasParens = term.trim().startsWith('(') && term.trim().endsWith(')');
    const body = lits.map(l => l.var + (l.comp ? "'" : '')).join('');
    return hasParens ? '(' + body + ')' : body;
}

function sortBooleanExpression(expr) {
    if (!expr || expr === '0' || expr === '1' || expr === 'TRUE' || expr === 'FALSE') return expr;
    if (expr.includes('(') && expr.includes(')')) {
        const clauses = [];
        let i = 0;
        while (i < expr.length) {
            if (expr[i] === '(') {
                let end = expr.indexOf(')', i);
                if (end === -1) end = expr.length;
                const rawClause = expr.substring(i + 1, end);
                const lits = rawClause.split('+').map(s => s.trim()).filter(Boolean);
                lits.sort((a, b) => {
                    const varA = a.replace(/['!]/g, '');
                    const varB = b.replace(/['!]/g, '');
                    if (varA !== varB) return varA.localeCompare(varB);
                    const compA = a.includes("'") || a.includes("!");
                    const compB = b.includes("'") || b.includes("!");
                    return compA === compB ? 0 : (compA ? 1 : -1);
                });
                clauses.push('(' + lits.join('+') + ')');
                i = end + 1;
            } else if (/[a-zA-Z0-9_]/.test(expr[i])) {
                let start = i;
                while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) i++;
                while (i < expr.length && (expr[i] === "'" || expr[i] === "!")) i++;
                clauses.push(expr.substring(start, i));
            } else {
                i++;
            }
        }
        if (clauses.length > 0) {
            clauses.sort(compareSopTermsJS);
            return clauses.join('');
        }
    }

    const terms = expr.split('+').map(s => s.trim()).filter(Boolean);
    if (terms.length <= 1) {
        return sortLiteralsInSingleTermJS(expr.trim());
    }

    const sortedTerms = terms.map(t => sortLiteralsInSingleTermJS(t));
    sortedTerms.sort(compareSopTermsJS);
    return sortedTerms.join(' + ');
}

        // Generate Solutions Array
        let solutions = [];
        let primaryExpr = '';
        if (Module.ccall('mantiq_isAlwaysTrue', 'number', [], []) !== 0) {
            primaryExpr = 'TRUE';
            solutions = [{ expr: 'TRUE', color: 'var(--success)' }];
        } else if (Module.ccall('mantiq_isAlwaysFalse', 'number', [], []) !== 0) {
            primaryExpr = 'FALSE';
            solutions = [{ expr: 'FALSE', color: 'var(--error)' }];
        } else {
            primaryExpr = sortBooleanExpression(queryWasmString('mantiq_getSimplifiedExpr'));
            solutions.push({ 
                expr: primaryExpr, 
                color: 'var(--success)' 
            });
            try {
                const solsJSON = queryWasmString('mantiq_getAllSolutions');
                const sols = JSON.parse(solsJSON || '[]');
                sols.forEach(s => {
                    const sortedS = sortBooleanExpression(s);
                    if (sortedS !== solutions[0].expr && !solutions.some(item => item.expr === sortedS)) {
                        solutions.push({ expr: sortedS, color: 'var(--text-primary)' });
                    }
                });
            } catch (e) {}
        }
        lastSimplifiedExpr = primaryExpr;
        
        // Render into Carousel
        elements.solutionsCarousel.innerHTML = '';
        
        const currentActiveIdx = (typeof selectedSolutionIndex !== 'undefined') ? selectedSolutionIndex : 0;

        solutions.forEach((sol, index) => {
            const card = document.createElement('div');
            card.className = 'solution-card' + (index === currentActiveIdx ? ' selected-solution' : '');
            
            const textSpan = document.createElement('span');
            textSpan.className = 'expr-text';
            textSpan.style.color = sol.color;
            textSpan.textContent = sol.expr;

            if (solutions.length > 1) {
                textSpan.style.cursor = 'pointer';
                textSpan.title = 'Click to select this solution for Circuit/Verilog/Simulation';
                textSpan.addEventListener('click', () => {
                    document.querySelectorAll('.solution-card').forEach(c => c.classList.remove('selected-solution'));
                    card.classList.add('selected-solution');
                    
                    if (typeof Module !== 'undefined' && Module.ccall) {
                        Module.ccall('mantiq_setSelectedSolution', null, ['number'], [index]);
                        
                        selectedSolutionIndex = index;
                        window.globalSelectedSolutionIndex = index;
                        
                        const activeBtn = document.querySelector('.nav-btn.active');
                        if (activeBtn) {
                            const viewMode = activeBtn.getAttribute('data-view');
                            if (viewMode === '3' && typeof renderTruthTableAndWaveform === 'function') renderTruthTableAndWaveform();
                            else if (viewMode === '4' && typeof renderVerilogHTML === 'function') renderVerilogHTML();
                            else if (viewMode === '0' && typeof renderHTMLSimulation === 'function') renderHTMLSimulation();
                            else if (viewMode === '1' && typeof renderHTMLCircuit === 'function') renderHTMLCircuit();
                            else if (viewMode === '5' && typeof renderSolutionView === 'function') renderSolutionView();
                        }
                    }
                });
            }
            
            const copyBtn = document.createElement('button');
            copyBtn.className = 'action-icon-btn copy-sol-btn';
            copyBtn.title = 'Copy expression';
            copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(sol.expr).then(() => {
                    showToast('Expression copied!', 'success');
                }).catch(() => {
                    showToast('Failed to copy', 'error');
                });
            });
            
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'solution-card-actions';
            actionsDiv.appendChild(copyBtn);
            
            card.appendChild(textSpan);
            card.appendChild(actionsDiv);
            elements.solutionsCarousel.appendChild(card);
        });
        
    } else if (expr === '') {
        elements.emptyState.style.display = 'flex';
        elements.resultRow.style.display = 'none';
    }
    // Note: If `expr` is non-empty but currently invalid/incomplete (hasResult is false), 
    // we intentionally skip hiding the result row or views, preserving the last stable cache on screen!

    const appRootEl = document.getElementById('app-root');
    if (appRootEl) {
        if (expr === '') {
            appRootEl.classList.add('landing');
        } else if (wasmHasResult && appRootEl.classList.contains('landing')) {
            appRootEl.classList.remove('landing');
            appRootEl.classList.remove('showing-examples');
        }
    }

    // Expression status button (error / share icon)
    const exprStatusBtn = document.getElementById('expr-status-btn');
    if (exprStatusBtn) {
        if (expr === '' || (appRootEl && appRootEl.classList.contains('landing'))) {
            exprStatusBtn.style.display = 'none';
        } else if (!manualError && wasmHasResult) {
            // Valid State -> Show Share Icon
            exprStatusBtn.style.display = 'flex';
            exprStatusBtn.className = 'state-share';
            exprStatusBtn.removeAttribute('title');
        } else {
            // Error State -> Show Error Icon and specific message
            exprStatusBtn.style.display = 'flex';
            exprStatusBtn.className = 'state-error';
            exprStatusBtn.setAttribute('title', manualError || "Invalid logic expression syntax");
        }
    }

    // Sync Hash
    if (expr && !manualError) {
        window.location.hash = `#expr=${encodeURIComponent(expr)}`;
    } else if (expr === '') {
        window.history.replaceState(null, null, ' ');
    }

    // Update active views only if we have a valid result to prevent jittering
    if (hasResult) {
        const activeBtn = document.querySelector('.nav-btn.active');
        if (activeBtn) {
            const viewMode = activeBtn.getAttribute('data-view');
            if (viewMode === '3') renderTruthTableAndWaveform();
            else if (viewMode === '4') renderVerilogHTML();
            else if (viewMode === '1') renderHTMLCircuit();
            else if (viewMode === '0') renderHTMLSimulation(false);
            else if (viewMode === '2') renderHTMLKMap();
            else if (viewMode === '5' && typeof renderSolutionView === 'function') renderSolutionView();
        }
    }
}

// Small helper to keep dynamically-inserted log text safe
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function applySymbolReplacements(text) {
    if (!text) return text;
    return text
        // 1. Multi-character operators FIRST (so sub-parts don't trigger single replacements)
        .replace(/<->/g, '↔')
        .replace(/->/g, '→')
        
        // 2. Single-character ASCII logical equivalents
        .replace(/!/g, '¬')
        .replace(/~/g, '¬')
        .replace(/\|/g, '∨')
        .replace(/&/g, '∧')
        .replace(/\^/g, '⊕')
        .replace(/=/g, '↔') // Single '=' maps to biconditional/equivalence
}

// Global replacement listener for inputs, textareas, and contenteditable elements
document.addEventListener('input', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const originalValue = target.value;
        const newValue = applySymbolReplacements(originalValue);

        if (originalValue !== newValue) {
            target.value = newValue;
            
            // Maintain cursor position accurately after replacement
            const diff = newValue.length - originalValue.length;
            target.setSelectionRange(start + diff, end + diff);

            // If it's the main expression input, trigger an input event simulation 
            // so Mantiq's reactive pipeline immediately picks up the new symbol
            if (target.id === 'expression-input') {
                target.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }
}, true);

// Holds the last raw QM log so the "Copy Steps" button can grab it verbatim
let currentQMStepsRaw = '';

// On mobile, the Algebraic Proof / Quine-McCluskey pill only makes sense
// as a *choice* when there's actually something to switch to. When no
// algebraic proof is logged for the current expression, hide the pill/tab
// bar outright and pin the split view to the QM panel, rather than
// offering a toggle with a dead "Algebraic Proof" option on one side.
function setAlgProofAvailability(hasAlgProof) {
    const mobileTabs = document.getElementById('solution-mobile-tabs');
    const splitView = document.getElementById('solution-split-view');
    const pill = document.getElementById('solution-type-pill');
    if (!mobileTabs || !splitView) return;

    const wasUnavailable = mobileTabs.classList.contains('alg-unavailable');
    mobileTabs.classList.toggle('alg-unavailable', !hasAlgProof);

    if (!hasAlgProof) {
        // Only auto-switch to QM if the user is currently viewing the alg
        // panel AND it just became unavailable (not on every render while
        // the user is mid-typing). This avoids stealing focus during input.
        const currentTab = splitView.getAttribute('data-active-tab');
        if (!wasUnavailable && currentTab === 'alg') {
            splitView.setAttribute('data-active-tab', 'qm');
            if (pill) {
                pill.setAttribute('data-state', 'qm');
                pill.querySelectorAll('.pill-option').forEach(opt => {
                    opt.classList.toggle('active', opt.getAttribute('data-val') === 'qm');
                });
            }
        }
    } else if (wasUnavailable) {
        // Alg proof became available again — restore the alg tab so the
        // user sees the proof on the next expression that has one.
        const currentTab = splitView.getAttribute('data-active-tab');
        if (currentTab === 'qm') {
            splitView.setAttribute('data-active-tab', 'alg');
            if (pill) {
                pill.setAttribute('data-state', 'alg');
                pill.querySelectorAll('.pill-option').forEach(opt => {
                    opt.classList.toggle('active', opt.getAttribute('data-val') === 'alg');
                });
            }
        }
    }
}

// QM Steps Parser and Renderer
function renderSolutionView() {
    const algBody = document.getElementById('alg-body');
    const qmBody = document.getElementById('qm-body');
    if (!algBody || !qmBody) return;

    if (Module.ccall('mantiq_isAlwaysTrue', 'number', [], []) !== 0 ||
        Module.ccall('mantiq_isAlwaysFalse', 'number', [], []) !== 0) {
        algBody.innerHTML = '<div class="solution-empty">Constant expression, no proof.</div>';
        qmBody.innerHTML = '<div class="solution-empty">Constant expression, no minimization.</div>';
        setAlgProofAvailability(false);
        return;
    }

    let rawSteps = queryWasmString('mantiq_getQMSteps');
    if (!rawSteps) {
        algBody.innerHTML = '<div class="solution-empty">No steps logged.</div>';
        qmBody.innerHTML = '<div class="solution-empty">No steps logged.</div>';
        setAlgProofAvailability(false);
        return;
    }

    const selectedIndex = window.globalSelectedSolutionIndex || 0;
    const pill = document.getElementById('sop-pos-pill');
    const format = pill && pill.getAttribute('data-state') === 'pos' ? 'pos' : 'sop';

    const parts = rawSteps.split('=== POS Minimization ===');
    let sopPart = parts[0];
    let posPart = parts[1] ? '=== POS Minimization ===' + parts[1] : '';

    if (format === 'sop') {
        if (selectedIndex > 0) {
            const solRegex = new RegExp(`Solution\\s+${selectedIndex + 1}:\\s*(\\[.*?\\])`);
            const match = sopPart.match(solRegex);
            if (match) {
                const selectedTerms = match[1];
                sopPart = sopPart.replace(/Minimized Terms:\s*\[.*?\]/, `Minimized Terms: ${selectedTerms}`);
            }
        }
        rawSteps = sopPart;
    } else {
        if (posPart) {
            if (selectedIndex > 0) {
                const solRegex = new RegExp(`Solution\\s+${selectedIndex + 1}:\\s*(\\[.*?\\])`);
                const match = posPart.match(solRegex);
                if (match) {
                    const selectedTerms = match[1];
                    posPart = posPart.replace(/Minimized Terms:\s*\[.*?\]/, `Minimized Terms: ${selectedTerms}`);
                }
            }
            rawSteps = posPart;
        } else {
            rawSteps = sopPart; // Fallback
        }
    }

    const lines = rawSteps.split('\n');
    let qmHtml = '';
    let algHtml = '';
    let isAlgebraicSection = false;

    let stepCounter = 0;
    let sectionOpen = false;
    let stepOpen = false;
    let blockOpen = false;
    let formCls = '';
    let pendingAlgebraicReason = null;

    const detectForm = (text) => {
        const lower = text.toLowerCase();
        if (/\bsop\b/.test(lower)) return 'sop';
        if (/\bpos\b/.test(lower)) return 'pos';
        return '';
    };
    let isFinalResultSection = false;
    formCls = format; // seed from the SOP/POS pill; inner section titles (e.g.
                      // "Quine-McCluskey Minimization") carry no sop/pos wording
                      // of their own, so without this the very first real
                      // section would blank the accent color out again.

    // QM's working notation is binary/dash codes (001, 0-10, ...). Readers
    // still have to mentally translate each code into the literal term it
    // represents, so wherever we know a token IS such a code (merge pairs,
    // prime-implicant codes, grouped-minterm listings) we render it as a
    // two-line badge: the code on top, the actual literal term (ABC, A'BC,
    // ...) underneath.
    const proofVariables = () => {
        try {
            const vars = JSON.parse(queryWasmString('mantiq_getVariables') || '[]');
            return Array.isArray(vars) ? vars : [];
        } catch (_) {
            return [];
        }
    };
    const isBinaryToken = (tok) => /^[01\-]+$/.test(tok);
    // One span per bit position, in the same order as the binary code above
    // it, so the literal lines up character-for-character instead of
    // drifting once a dash drops a variable (011 -> "A'BC" reads fine, but
    // -11 -> "BC" no longer sits under the code that produced it). A dash
    // position renders as its own muted "-" placeholder, and negation is a
    // bar over the letter (matching textbook notation) rather than a
    // trailing apostrophe, which was shifting the following characters.
    const literalSpans = (binaryStr, vars, isPOS) => {
        let html = '';
        for (let j = 0; j < Math.min(binaryStr.length, vars.length); j++) {
            const bit = binaryStr[j];
            if (bit === '-') {
                html += `<span class="qm-lit-dash">-</span>`;
            } else {
                const negated = isPOS ? (bit === '1') : (bit === '0');
                html += `<span class="qm-lit-var${negated ? ' neg' : ''}">${escapeHtml(vars[j])}</span>`;
            }
        }
        return html || `<span class="qm-lit-dash">-</span>`;
    };
    const termBadge = (rawTok, badgeCls) => {
        const tok = rawTok.trim();
        const vars = proofVariables();
        if (isBinaryToken(tok) && vars.length > 0 && tok.length === vars.length) {
            const literalHtml = literalSpans(tok, vars, formCls === 'pos');
            return `<span class="qm-term-badge ${badgeCls}"><span class="qm-term-bin">${escapeHtml(tok)}</span><span class="qm-term-lit">${literalHtml}</span></span>`;
        }
        return `<span class="badge ${badgeCls}">${escapeHtml(tok)}</span>`;
    };
    // Plain decimal minterm indices (e.g. from "covers [1, 5]" or
    // "Minterms to cover: [...]") aren't codes to translate - just small
    // muted number chips, kept visually distinct from term badges.
    const bracketTokens = (str) => str.trim()
        .replace(/^\[|\]$/g, '')
        .split(/\s*,\s*/)
        .map(t => t.trim())
        .filter(Boolean);
    const numChip = (tok) => `<span class="qm-num-chip">${escapeHtml(tok)}</span>`;
    // Minterm indices covered by a PI, prefixed "m" so a plain "covers
    // [1, 2, 3]" line reads the same way as the Essential rows below it
    // ("-> 'bin' is essential (only one covering m3)"), which already carry
    // the "m" prefix. Without this, PI rows showed bare "1, 2, 3" right next
    // to Essential rows showing "m3" in the very same table.
    const mCovers = (str) => bracketTokens(str).map(t => /^\d+$/.test(t) ? `m${t}` : t);

    const appendHtml = (str) => {
        if (isAlgebraicSection) algHtml += str;
        else qmHtml += str;
    };

    // Merge and prime-implicant/essential lines used to render as one
    // bulky bordered .qm-row per line - for an expression of any real size
    // that's a wall of near-identical boxes. Consecutive lines of the same
    // kind are buffered here and flushed as a single compact table instead,
    // so a run of 8 merges becomes one 8-row table rather than 8 boxes.
    let pendingGroup = null; // { kind: 'merge' | 'pi', rows: [...] }

    const renderMergeTable = (rows) => `
        <div class="qm-merge-list">
            ${rows.map(r => `
                <div class="qm-merge-row">
                    ${termBadge(r.a, 'term')}
                    <span class="qm-merge-op">+</span>
                    ${termBadge(r.b, 'term')}
                    <span class="qm-merge-op">=</span>
                    ${termBadge(r.result, 'result')}
                </div>
            `).join('')}
        </div>
    `;

    const renderPiTable = (rows) => `
        <div class="qm-pi-list">
            ${rows.map(r => `
                <div class="qm-pi-card">
                    <div class="qm-pi-card-top">
                        <span class="qm-pi-card-label">${r.icon} ${escapeHtml(r.label)}</span>
                        ${termBadge(r.term, 'result')}
                    </div>
                    <div class="qm-pi-card-covers">
                        <span class="qm-pi-covers-op">covers</span>
                        <div class="qm-term-list">${r.covers.map(numChip).join('')}</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    const flushGroup = () => {
        if (!pendingGroup) return;
        if (!blockOpen) { appendHtml('<div class="qm-block">'); blockOpen = true; }
        appendHtml(pendingGroup.kind === 'merge' ? renderMergeTable(pendingGroup.rows) : renderPiTable(pendingGroup.rows));
        pendingGroup = null;
    };

    const pushGroupRow = (kind, row) => {
        if (pendingGroup && pendingGroup.kind !== kind) flushGroup();
        if (!pendingGroup) pendingGroup = { kind, rows: [] };
        pendingGroup.rows.push(row);
    };

    const closeBlock = () => { flushGroup(); if (blockOpen) { appendHtml('</div>'); blockOpen = false; } };
    const closeStep = () => { closeBlock(); if (stepOpen) { appendHtml('</div></details>'); stepOpen = false; } };
    const closeSection = () => { closeStep(); if (sectionOpen) { appendHtml('</div>'); sectionOpen = false; } };

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // --- Section headers: "=== Title ===" -----------------------------
        if (trimmed.startsWith('===')) {
            const cleanTitle = trimmed.replace(/=/g, '').trim();

            // The wasm log itself opens with a bare "=== SOP Minimization ==="
            // marker directly in front of "=== Quine-McCluskey Minimization
            // ===", and the SOP/POS split in the caller re-prepends the same
            // pattern ("=== POS Minimization ===") in front of the second,
            // otherwise-identical run. Neither carries any content of its
            // own - it's just the only sop/pos wording in that half - so
            // both are treated as a silent color-switch marker rather than
            // opening a visible section (which is what produced the
            // duplicate "SOP Minimization" / "Quine-McCluskey Minimization"
            // stacked headers).
            const formMarkerMatch = cleanTitle.match(/^(sop|pos) minimization$/i);
            if (formMarkerMatch) {
                formCls = formMarkerMatch[1].toLowerCase();
                return;
            }

            closeSection();
            isAlgebraicSection = cleanTitle.toLowerCase().includes('algebraic');
            const df = detectForm(cleanTitle);
            if (df) formCls = df; // keep prior color through generic-titled sections
            isFinalResultSection = /final minimization result/i.test(cleanTitle);
            appendHtml(`
                <div class="qm-section">
                    <div class="qm-section-title">
                        ${escapeHtml(cleanTitle)}
                    </div>
            `);
            sectionOpen = true;
            stepCounter = 0;
            return;
        }

        // --- Numbered step headers: "1. Initial Setup" ---------------------
        if (/^\d+\./.test(trimmed)) {
            closeStep();
            stepCounter++;
            const stepText = trimmed.replace(/^\d+\.\s*/, '');
            appendHtml(`
                <details class="qm-step" open>
                    <summary class="qm-step-summary">
                        <span class="qm-step-num">${stepCounter}</span>
                        <span class="qm-step-title">${escapeHtml(stepText)}</span>
                        <svg class="qm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </summary>
                    <div class="qm-step-body">
            `);
            stepOpen = true;
            return;
        }

        if (!blockOpen) { appendHtml('<div class="qm-block">'); blockOpen = true; }

        // --- Algebraic-proof lines (unrelated logger, kept as-is) ----------
        if (trimmed.startsWith('-- (') && trimmed.endsWith(') -->')) {
            pendingAlgebraicReason = trimmed.substring(4, trimmed.length - 5);
            return;
        }
        if (pendingAlgebraicReason !== null) {
            appendHtml(`
                <div class="qm-row algebraic-step">
                    <div class="alg-expr">${escapeHtml(trimmed)}</div>
                    <div class="alg-reason">
                        <span class="alg-by">${pendingAlgebraicReason === 'Given' ? '' : 'by'}</span>
                        <span class="alg-rule">${escapeHtml(pendingAlgebraicReason)}</span>
                    </div>
                </div>
            `);
            pendingAlgebraicReason = null;
            return;
        }

        // --- "--- Pass 1 (Grouping size 2) ---" subheaders -----------------
        let m;
        if ((m = trimmed.match(/^-{2,}\s*(.+?)\s*-{2,}$/))) {
            closeBlock();
            appendHtml(`<h4 class="qm-h3"><span class="qm-status-dot"></span>${escapeHtml(m[1])}</h4>`);
            return;
        }

        // --- Bare "Label:" subheaders with no value on the line ------------
        // ("Initial Term Binary Representations:", "Final Valid Prime
        // Implicants:", "Finding Essential Prime Implicants:") - matched
        // generically instead of hardcoding each phrase, and crucially
        // NOT routed through the boxed-answer treatment below.
        if (/:$/.test(trimmed) && trimmed.length < 60) {
            closeBlock();
            appendHtml(`<h4 class="qm-h3"><span class="qm-status-dot"></span>${escapeHtml(trimmed.slice(0, -1))}</h4>`);
            return;
        }

        // --- "m0 = 000" / "m0 = 000 (d)" initial term rows -----------------
        if ((m = trimmed.match(/^(m\d+)\s*=\s*([01\-]+)(\s*\(d\))?$/))) {
            appendHtml(`
                <div class="qm-row">
                    <span class="qm-row-label">${escapeHtml(m[1])}</span>
                    <span class="qm-row-op">=</span>
                    ${termBadge(m[2], 'term')}
                    ${m[3] ? '<span class="badge dc">don\'t care</span>' : ''}
                </div>
            `);
            return;
        }

        // --- "Merged: A + B -> C" -- buffered into a compact merge table --
        if (trimmed.startsWith('Merged:')) {
            const rest = trimmed.substring(7).trim();
            const parts = rest.split(/\s*->\s*|\s*\+\s*/);
            if (parts.length >= 3) {
                pushGroupRow('merge', { a: parts[0], b: parts[1], result: parts[2] });
            } else {
                flushGroup();
                appendHtml(`<div class="qm-row">${escapeHtml(trimmed)}</div>`);
            }
            return;
        }

        // --- "* PI: bin covers [minterms]" (newly-found prime implicant) --
        // buffered into a compact PI table alongside the other PI-family
        // rows below (final-list PIs, essentials).
        if (trimmed.startsWith('* PI:')) {
            const rest = trimmed.substring(5).trim();
            const covMatch = rest.match(/^(\S+)\s+covers\s+(\[.*\])$/);
            if (covMatch) {
                pushGroupRow('pi', { icon: '&#9733;', label: 'Prime Implicant', term: covMatch[1], covers: mCovers(covMatch[2]) });
            } else {
                pushGroupRow('pi', { icon: '&#9733;', label: 'PI', term: rest, covers: [] });
            }
            return;
        }

        // --- "bin covers [minterms]" (Final Valid Prime Implicants list) --
        if ((m = trimmed.match(/^([01\-]+)\s+covers\s+(\[.*\])$/))) {
            pushGroupRow('pi', { icon: '&#10003;', label: 'Prime Implicant', term: m[1], covers: mCovers(m[2]) });
            return;
        }

        // --- "-> 'bin' is essential (only one covering m3)" ----------------
        if ((m = trimmed.match(/^->\s*'([^']+)'\s+is essential\s*\(only one covering m(\d+)\)$/))) {
            pushGroupRow('pi', { icon: '&#9733;', label: 'Essential', term: m[1], covers: ['m' + m[2]] });
            return;
        }

        // Every other line type below is unrelated to the merge/PI tables -
        // flush whatever's buffered before rendering it.
        flushGroup();

        // --- "-> bin1 is dominated by bin2 (Discarded)" --------------------
        if ((m = trimmed.match(/^->\s*(\S+)\s+is dominated by\s+(\S+)\s*\(Discarded\)$/))) {
            appendHtml(`
                <div class="qm-row qm-row-discarded">
                    ${termBadge(m[1], 'term discarded')}
                    <span class="qm-row-op">dominated by</span>
                    ${termBadge(m[2], 'term')}
                    <span class="badge discarded">discarded</span>
                </div>
            `);
            return;
        }

        // --- "No more merges possible." / "No essential PIs found." -------
        if (/^No (more merges possible|essential prime implicants found)\.$/.test(trimmed)) {
            appendHtml(`<div class="qm-row qm-row-note">${escapeHtml(trimmed)}</div>`);
            return;
        }

        // --- "Solution 2: [1-0, 0-1]" ---------------------------------------
        if ((m = trimmed.match(/^(Solution\s+\d+):\s*(\[.*\])$/))) {
            appendHtml(`
                <div class="qm-row qm-term-list-row">
                    <span class="qm-row-label">${escapeHtml(m[1])}</span>
                    <div class="qm-term-list">${bracketTokens(m[2]).map(t => termBadge(t, 'term')).join('')}</div>
                </div>
            `);
            return;
        }

        // --- "Minimized Terms: [...]" - the actual final boxed answer -----
        if ((m = trimmed.match(/^Minimized Terms:\s*(\[.*\])$/))) {
            closeBlock();
            const terms = bracketTokens(m[1]);
            // SOP terms are summed ("+"); POS terms are a product of sums,
            // so joining them with "+" is wrong - use a middle-dot instead.
            const joinerHtml = formCls === 'pos'
                ? '<span class="qm-final-plus qm-final-dot">&middot;</span>'
                : '<span class="qm-final-plus">+</span>';
            appendHtml(`
                <div class="qm-final">
                    <span class="qm-final-label">Minimized Result</span>
                    <div class="qm-final-terms">${terms.map(t => termBadge(t, 'result')).join(joinerHtml)}</div>
                </div>
            `);
            return;
        }

        // --- Generic "Label: value" lines (Variables, Minterms to cover,
        // Don't Cares, Solutions found, ...) - decimal listings get plain
        // number chips; anything else prints as-is. --------------------------
        let label = '';
        let rest = trimmed;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1 && colonIdx < 48) {
            label = trimmed.substring(0, colonIdx).trim();
            rest = trimmed.substring(colonIdx + 1).trim();
        }
        if (/^\[.*\]$/.test(rest)) {
            const tokens = bracketTokens(rest);
            const vars = proofVariables();
            const isCodeListing = vars.length > 0 && tokens.length > 0 &&
                tokens.every(t => isBinaryToken(t) && t.length === vars.length);
            appendHtml(`
                <div class="qm-row qm-term-list-row">
                    ${label ? `<span class="qm-row-label">${escapeHtml(label)}</span>` : ''}
                    <div class="qm-term-list">${tokens.map(t => isCodeListing ? termBadge(t, 'term') : numChip(t)).join('')}</div>
                </div>
            `);
        } else if (label) {
            appendHtml(`
                <div class="qm-row">
                    <span class="qm-row-label">${escapeHtml(label)}</span>
                    <span class="qm-row-value" style="font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 500; color: var(--text-primary); margin-left: 2px;">${escapeHtml(rest)}</span>
                </div>
            `);
        } else {
            appendHtml(`<div class="qm-row">${escapeHtml(trimmed)}</div>`);
        }
    });

    closeSection();
    
    qmBody.innerHTML = qmHtml || '<div class="solution-empty">No Quine-McCluskey steps logged.</div>';
    algBody.innerHTML = algHtml || '<div class="solution-empty">No algebraic proof logged.</div>';
    setAlgProofAvailability(!!algHtml);
}

// Render Alternative Solutions list
function renderAlternatives() {
    try {
        const solsJSON = queryWasmString('mantiq_getAllSolutions');
        const sols = JSON.parse(solsJSON || '[]');
        let html = '';
        
        sols.forEach((sol, i) => {
            html += `
                <div class="sol-row">
                    <span class="sol-option">Option ${i + 1}</span>
                    <span class="sol-expr">${sol}</span>
                    <button class="action-icon-btn copy-sol-btn" data-sol="${sol}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
            `;
        });
        
        elements.altBody.innerHTML = html || '<p>No alternative solutions.</p>';
        
        // Wire copy buttons inside solutions
        document.querySelectorAll('.copy-sol-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sol = btn.getAttribute('data-sol');
                navigator.clipboard.writeText(sol).then(() => {
                    showToast('Solution copied!');
                });
            });
        });
        
    } catch (e) {
        elements.altBody.innerHTML = '<p>Error loading solutions.</p>';
    }
}

// State Syncing Loop
// State Syncing Loop
// Views are updated reactively via state-snapshot messages from the worker.
// This loop only handles lightweight per-frame UI state that must stay in sync
// with user actions (nav button highlights, view transitions).
let lastLandingState = null;
function syncLoop() {
    if (wasmReady) {
        // Sync Active View Mode (reads instantly from _state cache)
        try {
            const activeView = _state.currentView;
            const appRootEl = document.getElementById('app-root');
            const isLanding = !!(appRootEl && appRootEl.classList.contains('landing'));

            // Re-run the view switch either when the numeric view mode
            // changes, OR when we transition into/out of the landing
            // screen with the same view mode still selected (e.g. typing
            // an expression while "Simulation" stays the active nav
            // button) — otherwise the panel never gets revealed once
            // landing is removed, since handleViewChange() bails out
            // while landing is active and nothing else re-triggers it.
            if (activeView !== lastActiveView || isLanding !== lastLandingState) {
                lastActiveView = activeView;
                lastLandingState = isLanding;
                elements.navButtons.forEach(btn => {
                    const btnView = parseInt(btn.getAttribute('data-view'));
                    if (btnView === activeView) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
                handleViewChange(activeView);
            }
        } catch (e) {
            console.error('[Mantiq] syncLoop error:', e);
        }
    }
    requestAnimationFrame(syncLoop);
}

window.onMantiqInit = function() {
    // wasmReady already set to true by the worker bridge above
    console.log('[Mantiq] WASM Engine fully active in worker thread.');

    // Dismiss loading overlay
    var overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        overlay.style.visibility = 'hidden';
        setTimeout(() => overlay.remove(), 600);
    }

    // Initial load from Hash
    if (window.location.hash.startsWith('#expr=')) {
        const initialExpr = decodeURIComponent(window.location.hash.substring(6));
        if (initialExpr.trim() !== '') {
            elements.input.value = initialExpr;
            const appRoot = document.getElementById('app-root');
            if (appRoot) {
                appRoot.classList.remove('landing');
            }
            const clearBtn = document.getElementById('clear-input-btn');
            if (clearBtn) {
                clearBtn.style.display = 'flex';
            }
            Module.ccall('mantiq_setExpression', null, ['string'], [initialExpr]);
        }
    }

    // Set Default active view
    Module.ccall('mantiq_setView', null, ['number'], [0]); // Simulation
    
    // ── FORCE INITIAL LAYOUT REFLOW ON STARTUP ──
    requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        if (typeof fitToContainer === 'function') {
            fitToContainer('simOrig');
            fitToContainer('simSimp');
        }
    });

    // Start syncing loop
    requestAnimationFrame(syncLoop);
};

// State transitions fade helper
function changeState(actionFn) {
    const mainWorkspace = document.getElementById('main-workspace');
    if (mainWorkspace) {
        mainWorkspace.classList.add('fade-out');
        setTimeout(() => {
            actionFn();
            requestAnimationFrame(() => {
                setTimeout(() => {
                    mainWorkspace.classList.remove('fade-out');
                }, 40);
            });
        }, 150);
    } else {
        actionFn();
    }
}

// Event Listeners
elements.input.addEventListener('input', (e) => {
    const expr = e.target.value;
    const clearBtn = document.getElementById('clear-input-btn');
    if (clearBtn) {
        clearBtn.style.display = expr.trim() !== '' ? 'flex' : 'none';
    }
    
    const appRoot = document.getElementById('app-root');
    if (appRoot) {
        if (expr.trim() !== '') {
            appRoot.classList.remove('showing-examples');
        } else if (!appRoot.classList.contains('landing')) {
            // Input was cleared out entirely - go back to the landing screen
            // right away, no need to wait on anything.
            changeState(() => {
                appRoot.classList.add('landing');
            });
        }
        // Note: leaving the landing screen for a non-empty expression is
        // handled in updateFrontend() once the expression is confirmed valid
        // (hasResult) and only after that view has actually been rendered -
        // not here on every keystroke - so an invalid or still-computing
        // expression never flashes an empty/laggy main page.
    }
    
    if (!wasmReady) return;
    Module.ccall('mantiq_setExpression', null, ['string'], [expr]);
    updateFrontend();
});

// Clear input button
const clearBtn = document.getElementById('clear-input-btn');
if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        changeState(() => {
            elements.input.value = '';
            clearBtn.style.display = 'none';
            
            const appRoot = document.getElementById('app-root');
            if (appRoot) {
                appRoot.classList.add('landing');
                appRoot.classList.remove('showing-examples');
            }
            
            window.history.replaceState(null, null, ' ');
            
            if (wasmReady) {
                Module.ccall('mantiq_setExpression', null, ['string'], ['']);
                updateFrontend();
            }
        });
        
        elements.input.focus();
    });
}

// Logo click to return to landing page
const heroLogoWrap = document.getElementById('hero-logo-wrap');
if (heroLogoWrap) {
    heroLogoWrap.addEventListener('click', (e) => {
        e.preventDefault();
        const appRoot = document.getElementById('app-root');
        
        // Only trigger if we aren't already on the landing page
        if (appRoot && !appRoot.classList.contains('landing')) {
            changeState(() => {
                elements.input.value = '';
                const cBtn = document.getElementById('clear-input-btn');
                if (cBtn) cBtn.style.display = 'none';
                
                appRoot.classList.add('landing');
                appRoot.classList.remove('showing-examples');
                
                window.history.replaceState(null, null, ' ');
                
                if (wasmReady) {
                    Module.ccall('mantiq_setExpression', null, ['string'], ['']);
                    updateFrontend();
                }
            });
            // Intentionally not calling focus() here so the mobile keyboard doesn't randomly pop up
        }
    });
}

// Keyboard escape handlers
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        elements.altPopup.style.display = 'none';
        document.getElementById('share-popup').style.display = 'none';
        const formatGuidePopup = document.getElementById('format-guide-popup');
        if (formatGuidePopup) formatGuidePopup.style.display = 'none';
        const examplesPopup = document.getElementById('examples-popup');
        if (examplesPopup) examplesPopup.style.display = 'none';
    }
});

 

if (elements.sopPosPill) {
    elements.sopPosPill.addEventListener('click', () => {
        const isSop = elements.sopPosPill.getAttribute('data-state') === 'sop';
        const newState = isSop ? 'pos' : 'sop';
        
        elements.sopPosPill.setAttribute('data-state', newState);
        elements.sopPosPill.querySelectorAll('.pill-option').forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-val') === newState);
        });
        
        // Mantiq setSOP API: 1 = SOP, 0 = POS
        if (wasmReady) {
            Module.ccall('mantiq_setSOP', null, ['number'], [newState === 'sop' ? 1 : 0]);
            
            const expr = elements.input.value.trim();
            if (expr) {
                Module.ccall('mantiq_setExpression', null, ['string'], [expr]);
                updateFrontend();
            }
        }
    });
}

// Theme Toggle Pill
if (elements.themePill) {
    // Force the correct theme class on load to match the pill's initial
    // data-state="dark" — without this, a browser/OS reporting a light
    // color-scheme preference silently overrides :root to light values
    // before any click ever happens, so the page can start in light mode
    // even though the toggle shows "Dark" as selected.
    document.body.classList.toggle('dark-mode', elements.themePill.getAttribute('data-state') === 'dark');
    document.body.classList.toggle('light-mode', elements.themePill.getAttribute('data-state') === 'light');

    elements.themePill.addEventListener('click', () => {
        const isDark = elements.themePill.getAttribute('data-state') === 'dark';
        const newState = isDark ? 'light' : 'dark';

        document.body.classList.toggle('light-mode', newState === 'light');
        document.body.classList.toggle('dark-mode', newState === 'dark');

        elements.themePill.setAttribute('data-state', newState);
        elements.themePill.querySelectorAll('.pill-option').forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-val') === newState);
        });
    });
}

// Solution View Mobile Tab Toggle
const solutionTypePill = document.getElementById('solution-type-pill');
if (solutionTypePill) {
    solutionTypePill.addEventListener('click', (e) => {
        const targetOption = e.target.closest('.pill-option');
        if (!targetOption) return;
        
        const newVal = targetOption.getAttribute('data-val');
        solutionTypePill.setAttribute('data-state', newVal);
        solutionTypePill.querySelectorAll('.pill-option').forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-val') === newVal);
        });
        
        const splitView = document.getElementById('solution-split-view');
        if (splitView) {
            splitView.setAttribute('data-active-tab', newVal);
        }
    });
}

// K-Map View Mode Toggle (Normal / Wrap / 3D).
const kmapViewToggleBtn = document.getElementById('kmap-view-toggle-btn');
if (kmapViewToggleBtn) {
    kmapViewToggleBtn.addEventListener('click', () => {
        const numVars = lastKMapData ? lastKMapData.variables.length : 0;
        if (kmapViewMode === 'normal') {
            kmapViewMode = numVars <= 4 ? 'wrap' : '3d';
        } else {
            kmapViewMode = 'normal';
        }
        renderHTMLKMap();
    });
}


// Keep the K-Map view perfectly fit to its panel whenever the panel's
// size changes for ANY reason (window resize, sidebar collapse/expand,
// orientation change, etc.) rather than only when we explicitly re-render.
let kmapResizePending = false;
function resizeKMapView() {
    if (!lastKMapData) return;
    const kmapContainer = document.getElementById('kmap-container');
    if (!kmapContainer || kmapContainer.classList.contains('view-hidden')) return;

    const { variables, minterms, dontCares, solutions, solutionsPOS } = lastKMapData;
    const numVars = variables.length;

    const sopPosEl = document.getElementById('sop-pos-pill');
    const isSOP = sopPosEl ? sopPosEl.getAttribute('data-state') === 'sop' : true;
    const activeSolutions = isSOP ? solutions : solutionsPOS;
    let selectedIdx = typeof selectedSolutionIndex !== 'undefined' ? selectedSolutionIndex : 0;
    if (selectedIdx >= activeSolutions.length) selectedIdx = 0;
    const activeSolution = activeSolutions.length > 0 ? activeSolutions[selectedIdx] : [];

    if (numVars <= 4) {
        if (kmapViewMode === 'wrap') {
            renderWrapKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP);
        } else {
            render2DKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP, true);
        }
    } else if (kmapViewMode !== '3d') {
        renderMultiple2DKMaps(numVars, variables, minterms, dontCares, activeSolution, isSOP);
    }
}

const kmapVisualWrapperEl = document.getElementById('kmap-visual-wrapper');
if (kmapVisualWrapperEl && window.ResizeObserver) {
    const kmapResizeObserver = new ResizeObserver(() => {
        if (kmapResizePending) return;
        kmapResizePending = true;
        requestAnimationFrame(() => {
            kmapResizePending = false;
            resizeKMapView();
        });
    });
    kmapResizeObserver.observe(kmapVisualWrapperEl);
}

// Keep the waveform canvas perfectly fit to its panel whenever the panel's
// size changes for ANY reason (window resize, sidebar collapse/expand,
// orientation change, mobile viewport chrome show/hide, etc.) - previously
// it was only ever sized once, at render time, so it went stale on mobile
// the moment the layout changed after that.
let waveResizePending = false;
const waveScrollWrapperEl = document.querySelector('.wave-scroll-wrapper');
if (waveScrollWrapperEl && window.ResizeObserver) {
    const waveResizeObserver = new ResizeObserver(() => {
        if (waveResizePending) return;
        waveResizePending = true;
        requestAnimationFrame(() => {
            waveResizePending = false;
            if (lastTruthTableData) renderHTMLWaveform(lastTruthTableData);
        });
    });
    waveResizeObserver.observe(waveScrollWrapperEl);
}

// K-Map panel fullscreen toggle - expands the whole K-Map panel (2D, Wrap,
// or 3D view, whichever is active) to fill the viewport. Reuses the panel
// in place (rather than cloning into the shared #panel-fullscreen-overlay
// like the circuit/simulation panels do) since the K-Map's grid/3D canvas
// aren't built on the .zoom-content-wrapper pattern that overlay expects.
(function initKMapFullscreen() {
    const btn = document.getElementById('kmap-fullscreen-btn');
    const panel = document.querySelector('#kmap-container .kmap-panel');
    if (!btn || !panel) return;

    // #kmap-container (and everything in it) sits inside a z-index:8
    // stacking context. A descendant can set z-index: 999999 and it still
    // won't paint above siblings like the topbar/sidebar (z-index:10),
    // because stacking order is resolved within the nearest ancestor
    // stacking context first - position:fixed only escapes that context
    // for LAYOUT (viewport-relative coordinates), not for paint order. So
    // to actually cover everything, the panel itself is relocated to be a
    // direct child of <body> while fullscreen, then moved back afterwards.
    const anchor = document.createComment('kmap-panel-anchor');
    let isDetached = false;

    const notifyResize = () => {
        // The K-Map's own ResizeObserver picks up the panel's new size
        // automatically; the 3D view only listens for window resize events,
        // so dispatch one to make sure its canvas/camera catch up too.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        });
    };

    const setFullscreen = (on) => {
        if (on && !isDetached) {
            panel.parentNode.insertBefore(anchor, panel);
            document.body.appendChild(panel);
            isDetached = true;
        } else if (!on && isDetached) {
            anchor.parentNode.insertBefore(panel, anchor);
            anchor.remove();
            isDetached = false;
        }
        panel.classList.toggle('kmap-panel-fullscreen', on);
        btn.classList.toggle('active', on);
        btn.title = on ? 'Exit Fullscreen' : 'Fullscreen';
        document.body.style.overflow = on ? 'hidden' : '';
        notifyResize();
    };

    btn.addEventListener('click', () => {
        setFullscreen(!isDetached);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isDetached) {
            setFullscreen(false);
        }
    });
})();

// Sidebar is now fixed-width (no expand/collapse toggle)

// Fix Backspace / Key events being stolen by Emscripten/Raylib
// We must use capturing phase on window/document to intercept before Emscripten
['keydown', 'keyup', 'keypress'].forEach(evt => {
    window.addEventListener(evt, (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            e.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener(evt, (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            e.stopImmediatePropagation();
        }
    }, true);
});



// Sidebar Buttons View Mode changes
elements.navButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!wasmReady) return;
        if (e.currentTarget.classList.contains('disabled')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const viewMode = parseInt(e.currentTarget.getAttribute('data-view'));
        
        elements.navButtons.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        
        Module.ccall('mantiq_setView', null, ['number'], [viewMode]);
        lastActiveView = viewMode;
        handleViewChange(viewMode);
    });
});

function handleViewChange(viewMode) {
    const views = {
        tt: document.getElementById('truthtable-container'),
        verilog: document.getElementById('verilog-container'),
        svg: document.getElementById('svg-circuit-container'),
        sim: document.getElementById('simulation-container'),
        kmap: document.getElementById('kmap-container'),
        solution: document.getElementById('solution-container'),
        canvas: document.getElementById('canvas')
    };

    // Hide every view; CSS (not JS) owns each container's actual display
    // type (grid/flex/block), so we only ever toggle a class here.
    Object.values(views).forEach(el => el && el.classList.add('view-hidden'));

    // While the app is showing the landing screen (no expression loaded
    // yet), never reveal a view container. Without this, the unconditional
    // mantiq_setView(0) call at startup (and the view-mode cache firing
    // through syncLoop) un-hides the simulation panels before an
    // expression exists, and they render behind the centered hero/search
    // bar. Same risk applies when the input is cleared back to landing.
    const appRootEl = document.getElementById('app-root');
    if (appRootEl && appRootEl.classList.contains('landing')) {
        return;
    }

    const show = (key) => { if (views[key]) views[key].classList.remove('view-hidden'); };

    if (viewMode === 3) {
        show('tt');
        renderTruthTableAndWaveform();
    } else if (viewMode === 4) {
        show('verilog');
        renderVerilogHTML();
    } else if (viewMode === 1) {
        show('svg');
        renderHTMLCircuit();
    } else if (viewMode === 0) {
        show('sim');
        renderHTMLSimulation();
    } else if (viewMode === 2) {
        show('kmap');
        renderHTMLKMap();
    } else if (viewMode === 5) {
        show('solution');
        renderSolutionView();
    } else {
        show('canvas');
    }
}

// Modals Logic: Examples & Learn Formats
const seeExamplesBtn = document.getElementById('see-examples-btn');
const examplesPopup = document.getElementById('examples-popup');
const examplesClose = document.getElementById('examples-close');

if (seeExamplesBtn && examplesPopup) {
    seeExamplesBtn.addEventListener('click', (e) => {
        e.preventDefault();
        examplesPopup.style.display = 'flex';
    });
}

if (examplesClose && examplesPopup) {
    examplesClose.addEventListener('click', () => {
        examplesPopup.style.display = 'none';
    });
}

if (examplesPopup) {
    examplesPopup.addEventListener('click', (e) => {
        const exampleBtn = e.target.closest('.example-link-item');
        if (exampleBtn) {
            const expr = exampleBtn.getAttribute('data-expr');
            if (expr && elements.input) {
                elements.input.value = expr;
                // Dispatch input event to trigger expression processing natively
                elements.input.dispatchEvent(new Event('input', { bubbles: true }));
                examplesPopup.style.display = 'none';
            }
        } else if (e.target === examplesPopup) {
            examplesPopup.style.display = 'none';
        }
    });
}

const learnFormatsBtn = document.getElementById('learn-formats-btn');
const formatGuidePopup = document.getElementById('format-guide-popup');
const formatGuideClose = document.getElementById('format-guide-close');

if (learnFormatsBtn && formatGuidePopup) {
    learnFormatsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        formatGuidePopup.style.display = 'flex';
    });
}

if (formatGuideClose && formatGuidePopup) {
    formatGuideClose.addEventListener('click', () => {
        formatGuidePopup.style.display = 'none';
    });
}

// Verilog Testbench Pill Toggles
const verilogTbpills = document.querySelectorAll('.verilog-tb-toggle');
verilogTbpills.forEach(pill => {
    pill.addEventListener('click', (e) => {
        const clickedOption = e.target.closest('.pill-option');
        const currentState = pill.getAttribute('data-state');
        let newState = currentState === 'tb' ? 'no-tb' : 'tb';
        if (clickedOption) {
            newState = clickedOption.getAttribute('data-val');
        }
        
        if (newState === currentState) return; // No change
        
        // Sync all Verilog TB pills
        verilogTbpills.forEach(p => {
            p.setAttribute('data-state', newState);
            p.querySelectorAll('.pill-option').forEach(opt => {
                opt.classList.toggle('active', opt.getAttribute('data-val') === newState);
            });
        });
        
        _state.addTestbench = (newState === 'tb');
        
        if (wasmReady && _state.expression.trim() !== '') {
            _workerWriteCall('_refreshViewFields');
            updateFrontend();
        }
    });
});

// SOP / POS Pill Toggle



// Popups closing
elements.altClose.addEventListener('click', () => elements.altPopup.style.display = 'none');

// Expression status button — opens the share popup when the expression is valid;
// when it's an error, the native title attribute handles the tooltip automatically.
// Expression status button — handles both share popup and error feedback click
document.getElementById('expr-status-btn').addEventListener('click', function() {
    if (this.classList.contains('state-share')) {
        const shareUrl = window.location.origin + window.location.pathname + '#expr=' + encodeURIComponent(elements.input.value.trim());
        const linkInput = document.getElementById('share-link-input');
        const copyBtn = document.getElementById('share-copy-btn');

        linkInput.value = shareUrl;

        // Reset copy button state
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span>';

        document.getElementById('share-popup').style.display = 'flex';
    } 
    else if (this.classList.contains('state-error')) {
        const errorMsg = this.getAttribute('title');
        if (errorMsg) {
            // Trigger a clean toast notification instead of modifying panel elements
            showToast(errorMsg, 'error');
        }
    }
});

// Share popup: copy link
document.getElementById('share-copy-btn').addEventListener('click', function() {
    const linkInput = document.getElementById('share-link-input');
    navigator.clipboard.writeText(linkInput.value).then(() => {
        this.classList.add('copied');
        this.innerHTML = '<span>Copied!</span>';
        showToast('Link copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
});

// Share popup: close
document.getElementById('share-close').addEventListener('click', () => {
    document.getElementById('share-popup').style.display = 'none';
});

// Keyboard escape handlers
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        elements.altPopup.style.display = 'none';
        document.getElementById('share-popup').style.display = 'none';
    }
});

// PWA Install Handlers
let deferredPrompt;
const pwaPopup = document.getElementById('pwa-popup');
const installBtn = document.getElementById('pwa-install-btn');
const iosInstructions = document.getElementById('pwa-ios-instructions');
const closeBtn = document.getElementById('pwa-close-btn');

const isIos = () => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
};

const isRunningStandalone = () => {
    return (window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone === true);
};

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isRunningStandalone()) {
        pwaPopup.style.display = 'block';
        installBtn.style.display = 'block';
    }
});

installBtn.addEventListener('click', async () => {
    pwaPopup.style.display = 'none';
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
    }
});

window.addEventListener('load', () => {
    if (isIos() && !isRunningStandalone()) {
        pwaPopup.style.display = 'block';
        iosInstructions.style.display = 'block';
    }
});

closeBtn.addEventListener('click', () => {
    pwaPopup.style.display = 'none';
});

// ==========================================================================
// Truth Table & Waveform Pure HTML/JS implementation
// ==========================================================================

function renderTruthTableAndWaveform() {
    if (!wasmReady) return;
    
    const jsonStr = queryWasmString('mantiq_getTruthTableJSON');
    const table = document.getElementById('html-truth-table');
    const waveCanvas = document.getElementById('waveform-canvas');
    
    if (!jsonStr) {
        lastTruthTableData = null;
        if (table) table.innerHTML = '<thead><tr><th>No expression processed yet</th></tr></thead>';
        if (waveCanvas) {
            const ctx = waveCanvas.getContext('2d');
            ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
        }
        return;
    }
    
    try {
        lastTruthTableData = JSON.parse(jsonStr);
    } catch (e) {
        console.error("Failed to parse Truth Table JSON:", e);
        return;
    }
    
    renderHTMLTruthTable(lastTruthTableData);
    renderHTMLWaveform(lastTruthTableData);
}

let lastTruthTableData = null;

function renderHTMLTruthTable(data) {
    const table = document.getElementById('html-truth-table');
    if (!table) return;
    
    let html = '<thead><tr>';
    // Headers
    data.variables.forEach(v => {
        html += `<th>${v}</th>`;
    });
    html += '<th class="tt-out-col">Out</th>';
    html += '<th>Minterm</th>';
    html += '</tr></thead><tbody>';
    
    // Rows
    data.rows.forEach(row => {
        html += `<tr data-row="${row.row}">`;
        row.inputs.forEach(bit => {
            html += `<td>${bit ? '1' : '0'}</td>`;
        });
        
        let outVal = row.output;
        let cellClass = 'output-cell';
        if (outVal === '1') cellClass += ' out-one';
        else if (outVal === '0') cellClass += ' out-zero';
        else cellClass += ' out-dontcare';
        
        html += `<td class="${cellClass}" data-row-idx="${row.row}">${outVal}</td>`;
        html += `<td style="color: var(--text-muted)">m${row.row}</td>`;
        html += '</tr>';
    });
    
    html += '</tbody>';
    table.innerHTML = html;
}

function renderHTMLWaveform(data) {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const wrapper = canvas.parentElement;
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    const pad = 20;
    const labelWidth = 60;
    
    const numVars = data.variables.length;
    const numSignals = numVars + 1;
    
    // Calculate required height to prevent vertical squishing (min 40px per signal)
    const minSlotH = 40; 
    const requiredAreaH = numSignals * minSlotH;
    const baseAreaH = rect.height - pad * 2;
    // Desktop always fits exactly inside the panel it's given - growing
    // past it just meant a scrollbar. Mobile keeps the old floor since its
    // screens are tight enough that sub-40px signal rows get unreadable.
    const isMobileWave = window.innerWidth <= 900;
    const availableH = isMobileWave ? Math.max(baseAreaH, requiredAreaH) : baseAreaH;
    const totalHeight = availableH + pad * 2;
    
    // Fit canvas horizontally to wrapper, but allow vertical expansion
    canvas.width = rect.width * dpr;
    canvas.height = totalHeight * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = totalHeight + 'px';
    
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, totalHeight);
    
    // Calculate heights dynamically based on the safe available height
    const slotH = availableH / numSignals;
    const signalH = slotH * 0.65; // Waveform line takes up 65% of slot height
    const signalGap = slotH * 0.35;
    
    // Reverted horizontal logic: perfectly fit to the screen width
    const areaW = rect.width - pad * 2 - labelWidth;
    const stepWidth = areaW / data.rows.length;
    const areaX = pad + labelWidth;
    const areaY = pad;
    
    // Draw background grid lines
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e2e8f0';
    ctx.strokeStyle = ctx.strokeStyle + '33'; // 20% opacity
    ctx.lineWidth = 1;
    for (let i = 0; i <= data.rows.length; i++) {
        const gridX = areaX + i * stepWidth;
        ctx.beginPath();
        ctx.moveTo(gridX, areaY);
        ctx.lineTo(gridX, areaY + numSignals * slotH - signalGap);
        ctx.stroke();
    }
    
    // Draw variables waveforms
    ctx.font = '500 14px Outfit, sans-serif';
    ctx.textBaseline = 'middle';
    
    for (let v = 0; v < numVars; v++) {
        const y = areaY + v * slotH;
        const varName = data.variables[v];
        
        const isDark = !document.body.classList.contains('light-mode');
        const defaultText = isDark ? '#f8fafc' : '#0f172a';
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || defaultText;
        ctx.textAlign = 'left';
        ctx.fillText(varName, pad, y + signalH / 2);
        
        drawSignalLine(ctx, areaX, y, stepWidth, signalH, data.rows.length, numVars, v, true, data);
    }
    
    // Draw output waveform
    const outY = areaY + numVars * slotH;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#10b981';
    ctx.textAlign = 'left';
    ctx.fillText('Out', pad, outY + signalH / 2);
    drawSignalLine(ctx, areaX, outY, stepWidth, signalH, data.rows.length, numVars, -1, false, data);
}

function drawSignalLine(ctx, x, y, stepWidth, height, numRows, numVars, varIndex, isInput, data) {
    const lowY = y + height - 5;
    const highY = y + 5;
    const midY = y + height / 2;
    const thickness = 2;
    
    const themeAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
    const themeSuccess = getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#10b981';
    
    ctx.strokeStyle = isInput ? themeAccent : themeSuccess;
    ctx.lineWidth = thickness;
    
    let prevValue = -1;
    ctx.beginPath();
    
    for (let i = 0; i < numRows; i++) {
        let value;
        if (isInput) {
            value = (i >> (numVars - 1 - varIndex)) & 1;
        } else {
            const outStr = data.rows[i].simplified_output || data.rows[i].output;
            value = (outStr === '1') ? 1 : 0;
        }
        
        const stepX = x + i * stepWidth;
        const currentY = (value === 1) ? highY : (value === 0.5 ? midY : lowY);
        
        if (prevValue !== -1 && prevValue !== value) {
            ctx.lineTo(stepX, currentY);
        } else if (prevValue === -1) {
            ctx.moveTo(stepX, currentY);
        }
        
        ctx.lineTo(stepX + stepWidth, currentY);
        prevValue = value;
    }
    ctx.stroke();
}

function initExportButtons() {
    const exportCsvBtn = document.getElementById('export-csv-btn');
    const exportWaveBtn = document.getElementById('export-wave-btn');
    const table = document.getElementById('html-truth-table');
    
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', () => {
            const jsonStr = queryWasmString('mantiq_getTruthTableJSON');
            if (jsonStr) {
                try {
                    const data = JSON.parse(jsonStr);
                    let csvContent = "data:text/csv;charset=utf-8,";
                    const headers = [...data.variables, "Output"].join(",");
                    csvContent += headers + "\r\n";
                    data.rows.forEach(row => {
                        const inputs = row.inputs.map(b => b ? "1" : "0");
                        csvContent += [...inputs, row.output].join(",") + "\r\n";
                    });
                    const encodedUri = encodeURI(csvContent);
                    const link = document.createElement("a");
                    link.setAttribute("href", encodedUri);
                    link.setAttribute("download", `truthtable_${new Date().toISOString().slice(0,19).replace(/[-T:]/g,"_")}.csv`);
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    showToast('CSV exported successfully!');
                } catch (e) {
                    showToast('Failed to export CSV', 'error');
                }
            }
        });
    }
    
    if (exportWaveBtn) {
        exportWaveBtn.addEventListener('click', () => {
            const canvas = document.getElementById('waveform-canvas');
            if (canvas) {
                try {
                    // Create a temporary canvas to apply a solid background
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = canvas.width;
                    tempCanvas.height = canvas.height;
                    const ctx = tempCanvas.getContext('2d');
                    
                    // Fetch the current theme's panel background color
                    const rootStyle = getComputedStyle(document.documentElement);
                    const bgColor = rootStyle.getPropertyValue('--bg-secondary').trim() || '#ffffff';
                    
                    // Fill background and draw original waveform on top
                    ctx.fillStyle = bgColor;
                    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
                    ctx.drawImage(canvas, 0, 0);
                    
                    const link = document.createElement("a");
                    link.setAttribute("href", tempCanvas.toDataURL('image/png'));
                    link.setAttribute("download", `waveform_${new Date().toISOString().slice(0,19).replace(/[-T:]/g,"_")}.png`);
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    showToast('Waveform exported as PNG!');
                } catch (e) {
                    showToast('Failed to export PNG', 'error');
                }
            }
        });
    }

    if (table) {
        table.addEventListener('click', (e) => {
            if (e.target.classList.contains('output-cell')) {
                const rowIdx = parseInt(e.target.getAttribute('data-row-idx'));
                toggleTruthTableOutput(rowIdx);
            }
        });
    }

    // Hook up Verilog Buttons
    const copyGateBtn = document.getElementById('copy-gate-btn');
    const saveGateBtn = document.getElementById('save-gate-btn');
    const copyDataflowBtn = document.getElementById('copy-dataflow-btn');
    const saveDataflowBtn = document.getElementById('save-dataflow-btn');

    if (copyGateBtn) {
        copyGateBtn.addEventListener('click', () => {
            const code = queryWasmString('mantiq_getVerilogCode', [1], ['number']);
            if (code) {
                navigator.clipboard.writeText(code).then(() => {
                    showToast('Gate Level Verilog copied!');
                }).catch(() => {
                    showToast('Failed to copy code', 'error');
                });
            }
        });
    }

    if (saveGateBtn) {
        saveGateBtn.addEventListener('click', () => {
            const code = queryWasmString('mantiq_getVerilogCode', [1], ['number']);
            if (code) {
                saveCodeToFile(code, 'gate_level');
            }
        });
    }

    if (copyDataflowBtn) {
        copyDataflowBtn.addEventListener('click', () => {
            const code = queryWasmString('mantiq_getVerilogCode', [0], ['number']);
            if (code) {
                navigator.clipboard.writeText(code).then(() => {
                    showToast('Dataflow Verilog copied!');
                }).catch(() => {
                    showToast('Failed to copy code', 'error');
                });
            }
        });
    }

    if (saveDataflowBtn) {
        saveDataflowBtn.addEventListener('click', () => {
            const code = queryWasmString('mantiq_getVerilogCode', [0], ['number']);
            if (code) {
                saveCodeToFile(code, 'dataflow');
            }
        });
    }

    // Hook up Zoom Buttons
    const zoomInOrig = document.getElementById('zoom-in-orig');
    const zoomOutOrig = document.getElementById('zoom-out-orig');
    const zoomFsOrig  = document.getElementById('zoom-fullscreen-orig');
    const zoomInSimp = document.getElementById('zoom-in-simp');
    const zoomOutSimp = document.getElementById('zoom-out-simp');
    const zoomFsSimp  = document.getElementById('zoom-fullscreen-simp');

    if (zoomInOrig) zoomInOrig.addEventListener('click', () => {
        const container = document.getElementById('original-circuit-scroll');
        if (container) {
            const rect = container.getBoundingClientRect();
            zoomAtPoint('orig', 1.15, rect.width / 2, rect.height / 2, true);
        }
    });
    if (zoomOutOrig) zoomOutOrig.addEventListener('click', () => {
        const container = document.getElementById('original-circuit-scroll');
        if (container) {
            const rect = container.getBoundingClientRect();
            zoomAtPoint('orig', 0.85, rect.width / 2, rect.height / 2, true);
        }
    });
    if (zoomFsOrig) zoomFsOrig.addEventListener('click', () => {
        openPanelFullscreen('orig');
    });

    if (zoomInSimp) zoomInSimp.addEventListener('click', () => {
        const container = document.getElementById('simplified-circuit-scroll');
        if (container) {
            const rect = container.getBoundingClientRect();
            zoomAtPoint('simp', 1.15, rect.width / 2, rect.height / 2, true);
        }
    });
    if (zoomOutSimp) zoomOutSimp.addEventListener('click', () => {
        const container = document.getElementById('simplified-circuit-scroll');
        if (container) {
            const rect = container.getBoundingClientRect();
            zoomAtPoint('simp', 0.85, rect.width / 2, rect.height / 2, true);
        }
    });
    if (zoomFsSimp) zoomFsSimp.addEventListener('click', () => {
        openPanelFullscreen('simp');
    });
}

function saveCodeToFile(code, prefix) {
    const filename = `${prefix}_${new Date().toISOString().slice(0,19).replace(/[-T:]/g,"_")}.v`;
    const blob = new Blob([code], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Saved ${filename}`);
}

function toggleTruthTableOutput(rowIdx) {
    if (!lastTruthTableData) return;
    
    const row = lastTruthTableData.rows[rowIdx];
    if (!row) return;
    
    // Cycle: 0 -> 1 -> X -> 0
    if (row.output === '0') {
        row.output = '1';
    } else if (row.output === '1') {
        row.output = 'X';
    } else {
        row.output = '0';
    }
    
    const vars = lastTruthTableData.variables;
const minterms = [];
    const dontCares = [];
    
    lastTruthTableData.rows.forEach(r => {
        if (r.output === '1') minterms.push(r.row);
        else if (r.output === 'X') dontCares.push(r.row);
    });

    // Sort numerically
    minterms.sort((a, b) => a - b);
    dontCares.sort((a, b) => a - b);
    
    let newExpr = "";
    if (vars && vars.length > 0) {
        newExpr += vars.join(",") + ": ";
    }
    if (minterms.length > 0) {
        newExpr += "m(" + minterms.join(",") + ")";
    }
    if (dontCares.length > 0) {
        if (minterms.length > 0) newExpr += " ";
        newExpr += "d(" + dontCares.join(",") + ")";
    }
    if (minterms.length === 0 && dontCares.length === 0) {
        newExpr += "m()";
    }

    elements.input.value = newExpr;
    elements.input.dispatchEvent(new Event('input', { bubbles: true }));
}

initExportButtons();

function renderVerilogHTML() {
    if (!wasmReady) return;
    
    const gateCode = queryWasmString('mantiq_getVerilogCode', [1], ['number']);
    const dataflowCode = queryWasmString('mantiq_getVerilogCode', [0], ['number']);
    
    const gateElem = document.getElementById('gate-level-code');
    const dataflowElem = document.getElementById('dataflow-code');
    
    if (gateElem) gateElem.textContent = gateCode || '// No code generated';
    if (dataflowElem) dataflowElem.textContent = dataflowCode || '// No code generated';
}

// ==========================================================================
// SVG Circuit Rendering
// ==========================================================================

function renderHTMLCircuit() {
    if (!wasmReady) return;
    const jsonStr = queryWasmString('mantiq_getCircuitJSON');
    console.log("Mantiq Debug - Circuit JSON:", jsonStr);
    const origScroll = document.getElementById('original-circuit-scroll');
    const simpScroll = document.getElementById('simplified-circuit-scroll');
    const origPanel = document.getElementById('original-circuit-panel');
    const container = document.getElementById('svg-circuit-container');
    
    if (!origScroll || !simpScroll || !origPanel || !container) return;
    
    if (!jsonStr) {
        origScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No expression processed yet</div>';
        simpScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No expression processed yet</div>';
        return;
    }
    
    let circuitData;
    try {
        circuitData = JSON.parse(jsonStr);
    } catch(e) {
        origScroll.innerHTML = '<div style="color:var(--error); text-align:center;">Error parsing circuit data</div>';
        simpScroll.innerHTML = '<div style="color:var(--error); text-align:center;">Error parsing circuit data</div>';
        return;
    }
    
    // Check if original circuit is a dummy / empty
    const isDummy = !circuitData.original || (circuitData.original.type === 'VAR' && circuitData.original.value === 'dummy');
    
    const origDepth = getGateDepth(circuitData.original);
    const simpDepth = getGateDepth(circuitData.simplified);
    
    container.classList.toggle('single-panel-view', isDummy);

    if (isDummy) {
        origPanel.style.display = 'none';
        container.style.gridTemplateColumns = '1fr';
        origScroll.innerHTML = '';
    } else {
        origPanel.style.display = 'flex';
        container.style.gridTemplateColumns = '1fr 1fr';
        
        if (origDepth > 99) { // Setting 99 to disable 10-level limit for original circuit
            origScroll.innerHTML = '<div class="exceeded-msg">Original circuit exceeds 99 levels of gates.</div>';
        } else {
            origScroll.innerHTML = generateSVGForCircuit(circuitData.original);
            fitToContainer('orig');
            centerPanel('orig');
        }
    }
    
    if (circuitData.isAlwaysTrue) {
        simpScroll.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; height:100%; font-size:24px; color:var(--success); font-weight:bold;">Always True (1)</div>';
    } else if (circuitData.isAlwaysFalse) {
        simpScroll.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; height:100%; font-size:24px; color:var(--error); font-weight:bold;">Always False (0)</div>';
    } else if (simpDepth > 99) { // Setting 99 to disable 10-level limit for simplified circuit
        simpScroll.innerHTML = '<div class="exceeded-msg">Simplified circuit exceeds 99 levels of gates.</div>';
    } else if (circuitData.simplified) {
        simpScroll.innerHTML = generateSVGForCircuit(circuitData.simplified);
        fitToContainer('simp');
        centerPanel('simp');
    } else {
        simpScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No simplified circuit</div>';
    }
    
    // Wire PNG Export
    const exportBtnOrig = document.getElementById('export-circuit-png-orig');
    if (exportBtnOrig) {
        const newBtn = exportBtnOrig.cloneNode(true);
        exportBtnOrig.parentNode.replaceChild(newBtn, exportBtnOrig);
        newBtn.addEventListener('click', () => {
            const svgEl = origScroll.querySelector('svg');
            if (svgEl) {
                exportSvgToPng(svgEl, `original_circuit_${new Date().toISOString().slice(0,19).replace(/[-T:]/g,"_")}.png`);
            } else {
                showToast('No original circuit diagram to export', 'error');
            }
        });
    }

    const exportBtnSimp = document.getElementById('export-circuit-png-simp');
    if (exportBtnSimp) {
        const newBtn = exportBtnSimp.cloneNode(true);
        exportBtnSimp.parentNode.replaceChild(newBtn, exportBtnSimp);
        newBtn.addEventListener('click', () => {
            const svgEl = simpScroll.querySelector('svg');
            if (svgEl) {
                exportSvgToPng(svgEl, `simplified_circuit_${new Date().toISOString().slice(0,19).replace(/[-T:]/g,"_")}.png`);
            } else {
                showToast('No simplified circuit diagram to export', 'error');
            }
        });
    }
    
    // Initialize Drag to Pan and Pinch to Zoom (once per panel - re-running this on
    // every render would stack duplicate mouse/touch listeners on top of each other)
    if (!container.dataset.zoomOrigInitialized) {
        initPanAndZoom('original-circuit-scroll', 'orig');
        container.dataset.zoomOrigInitialized = 'true';
    }
    if (!container.dataset.zoomSimpInitialized) {
        initPanAndZoom('simplified-circuit-scroll', 'simp');
        container.dataset.zoomSimpInitialized = 'true';
    }
}

// Resize can fire dozens of times a second during a drag-resize; each call to
// fitToContainer() does layout reads (clientWidth/clientHeight) + a style write.
// Coalesce to one pass per animation frame instead of one per resize event.
let _resizeRaf = null;
window.addEventListener('resize', () => {
    if (_resizeRaf !== null) return;
    _resizeRaf = requestAnimationFrame(() => {
        _resizeRaf = null;
        const activeBtn = document.querySelector('.nav-btn.active');
        if (activeBtn) {
            const view = activeBtn.getAttribute('data-view');
            if (view === '1') {
                fitToContainer('orig');
                fitToContainer('simp');
            } else if (view === '0') {
                fitToContainer('simOrig');
                fitToContainer('simSimp');
            }
        }
    });
});

function fitToContainer(panelType) {
    const m = _measureMetrics(panelType);
    if (!m) return;

    let scale = Math.min(m.cw / m.w, m.ch / m.h) * 0.9;
    // No artificial ceiling so small circuits fill space naturally;
    // floor at 0.05 so the widest circuits still render something visible.
    scale = Math.max(0.05, scale);

    const x = (m.cw - m.w * scale) / 2;
    const y = (m.ch - m.h * scale) / 2;

    // This IS the "maximum size, fully visible, centered" view — so it also
    // becomes the zoom-OUT limit: applyZoom() won't let state.scale go below
    // fitScale, and _clampPan() locks x/y centered whenever scale is at (or
    // below) that point. Zooming out can never go further than what you're
    // looking at right now.
    // contentW/contentH record the diagram size this fit was computed for,
    // so a later re-render can tell whether the diagram actually changed
    // shape (needs a fresh fit) or is the same size as before (safe to just
    // keep the user's existing pan/zoom) — see renderHTMLSimulation.
    panelsState[panelType] = { x, y, scale, fitScale: scale, contentW: m.w, contentH: m.h };
    applyZoom(panelType, false);
    _forceCrispRepaint(m.contentEl);
}

// True if the panel's diagram is a meaningfully different size than the one
// its current pan/zoom was fit to — e.g. typing changed the expression and
// the gate layout grew or shrank. In that case the OLD scale/position (fit
// for the old dimensions) no longer makes sense applied to the new content:
// it can leave the diagram oversized, cut off, or floating off-center
// instead of "not resizing properly". A same-size re-render (e.g. toggling
// a simulation input, which only changes signal colors, not layout) should
// NOT be treated as a resize — that's what preserves the user's zoom/pan
// across toggles.
function _contentSizeChanged(panelType, newW, newH) {
    const state = panelsState[panelType];
    if (!state || state.contentW == null || state.contentH == null) return true;
    const TOL = 1; // px - guards against float rounding, not real changes
    return Math.abs(state.contentW - newW) > TOL || Math.abs(state.contentH - newH) > TOL;
}


// Always use this (not a raw setTimeout guess) to center a panel's default view.
// A single requestAnimationFrame can still land before a just-triggered layout
// change (display:none -> flex, grid-template-columns edit) has been applied by
// the browser; nesting two rAFs guarantees we measure AFTER that layout settles,
// so the default view is reliably centered every time, not just "usually".
function centerPanel(panelType) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => fitToContainer(panelType));
    });
}

function zoomAtPoint(panelType, factor, px, py, smooth = false) {
    const state = panelsState[panelType];
    const oldScale = state.scale;
    let newScale = oldScale * factor;
    newScale = Math.max(0.05, Math.min(4.0, newScale));
    
    const actualFactor = newScale / oldScale;
    state.x = px - (px - state.x) * actualFactor;
    state.y = py - (py - state.y) * actualFactor;
    state.scale = newScale;
    
    applyZoom(panelType, smooth);

    // Button-triggered (smooth) zooms animate via a CSS transition, then stop
    // changing — force a fresh rasterization once that transition finishes so
    // we're not left showing the GPU-stretched bitmap from mid-animation.
    if (smooth) {
        let scrollId = '';
        if (panelType === 'orig') scrollId = 'original-circuit-scroll';
        else if (panelType === 'simp') scrollId = 'simplified-circuit-scroll';
        else if (panelType === 'simOrig') scrollId = 'original-sim-scroll';
        else if (panelType === 'simSimp') scrollId = 'simplified-sim-scroll';
        const scrollEl = document.getElementById(scrollId);
        const contentEl = scrollEl ? scrollEl.querySelector('.zoom-content-wrapper') : null;
        setTimeout(() => _forceCrispRepaint(contentEl), 160);
    }
}

// ==========================================================================
// Panel Fullscreen System
// ==========================================================================

let _fsPanelType = null;         // which panel is in fullscreen
let _fsState = { x: 0, y: 0, scale: 1 };  // pan/zoom state for the fs overlay
let _fsDragging = false;
let _fsDragStartX = 0, _fsDragStartY = 0, _fsInitX = 0, _fsInitY = 0;
let _fsTouchDist = 0, _fsTouchZoom = 1, _fsTouchMidX = 0, _fsTouchMidY = 0, _fsTouchInitX = 0, _fsTouchInitY = 0;

function _fsScrollId(panelType) {
    if (panelType === 'orig')    return 'original-circuit-scroll';
    if (panelType === 'simp')    return 'simplified-circuit-scroll';
    if (panelType === 'simOrig') return 'original-sim-scroll';
    if (panelType === 'simSimp') return 'simplified-sim-scroll';
    return '';
}

function _applyFsZoom(smooth = false) {
    const wrap = document.querySelector('#panel-fs-scroll .zoom-content-wrapper');
    if (!wrap || !_fsState.cw) return;
    
    // Read from cache instead of querying the DOM (kills layout thrashing!)
    const { cw, ch, w, h } = _fsState;

    if (_fsState.fitScale) {
        _fsState.scale = Math.max(_fsState.fitScale, _fsState.scale);
    }
    _clampPan(_fsState, cw, ch, w, h);

    wrap.style.transition = smooth ? 'transform 0.15s ease-out' : 'none';
    wrap.style.transform = `translate3d(${_fsState.x}px, ${_fsState.y}px, 0) scale3d(${_fsState.scale}, ${_fsState.scale}, 1)`;
}

function _fitFsToContainer() {
    const wrap = document.querySelector('#panel-fs-scroll .zoom-content-wrapper');
    const scrollEl = document.getElementById('panel-fs-scroll');
    if (!wrap || !scrollEl) return;
    const w = parseFloat(wrap.style.width)  || 400;
    const h = parseFloat(wrap.style.height) || 300;
    const cw = scrollEl.clientWidth  || 800;
    const ch = scrollEl.clientHeight || 600;
    // Fit entirely with 3% breathing room — same logic as fitToContainer
    let scale = Math.min(cw / w, ch / h) * 0.97;
    scale = Math.max(0.05, scale);
    const x = (cw - w * scale) / 2;
    const y = (ch - h * scale) / 2;
    _fsState = { x, y, scale, fitScale: scale, cw, ch, w, h };   
    _applyFsZoom(false);
    _forceCrispRepaint(wrap);
}

/**
 * Requests real browser fullscreen on the overlay and, where supported
 * (mainly Android Chrome/Firefox — iOS Safari has no Screen Orientation
 * Lock API), locks the screen to landscape. Orientation lock is only
 * permitted while the document is actually in fullscreen, so this must
 * run after requestFullscreen() resolves. Failures are silently ignored:
 * this is a nice-to-have, not a requirement for the panel to open.
 */
function _enterFsLandscape(overlay) {
    const req = overlay.requestFullscreen
        || overlay.webkitRequestFullscreen
        || overlay.msRequestFullscreen;
    if (!req) return;
    try {
        const result = req.call(overlay);
        const lockLandscape = () => {
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        };
        if (result && typeof result.then === 'function') {
            result.then(lockLandscape).catch(() => {});
        } else {
            lockLandscape();
        }
    } catch (_) { /* fullscreen/orientation lock unsupported — ignore */ }
}

/** Reverses _enterFsLandscape(): unlocks orientation and exits fullscreen. */
function _exitFsLandscape() {
    try {
        if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
        }
    } catch (_) {}
    const exit = document.exitFullscreen
        || document.webkitExitFullscreen
        || document.msExitFullscreen;
    if (document.fullscreenElement && exit) {
        try { exit.call(document); } catch (_) {}
    }
}

// requestFullscreen() and the orientation lock it enables are both async and,
// on mobile in particular, can resolve well after this frame (the OS still
// has to animate the rotation). _fitFsToContainer() measures the container's
// CURRENT size, so a single fit right after opening can run before that
// resize has actually happened and end up fitting to stale dimensions.
// _fsRefitHandler re-runs the fit whenever the viewport (or fullscreen state)
// actually changes while the overlay is open, so it always catches up.
let _fsRefitHandler = null;

function openPanelFullscreen(panelType) {
    const overlay = document.getElementById('panel-fullscreen-overlay');
    const fsScroll = document.getElementById('panel-fs-scroll');
    if (!overlay || !fsScroll) return;

    // Find source content
    const scrollId = _fsScrollId(panelType);
    const srcScroll = document.getElementById(scrollId);
    const srcWrap   = srcScroll ? srcScroll.querySelector('.zoom-content-wrapper') : null;
    if (!srcWrap) return;

    _fsPanelType = panelType;

    // Clone the content into the fullscreen scroll area
    fsScroll.innerHTML = '';
    const clone = srcWrap.cloneNode(true);
    // Remove any leftover transform — we'll re-fit in a moment
    clone.style.transition = 'none';
    clone.style.transform  = '';
    fsScroll.appendChild(clone);

    // Re-enable pointer events on all sim-toggle elements inside clone
    clone.querySelectorAll('.sim-toggle').forEach(el => {
        el.style.pointerEvents = 'auto';
        el.addEventListener('click', () => {
            const varName = el.getAttribute('data-var');
            if (varName && typeof toggleSimInput === 'function') {
                toggleSimInput(varName);
                // Rebuild fullscreen content after state change
                requestAnimationFrame(() => _refreshFsContent());
            }
        });
    });

    // Show overlay
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    _enterFsLandscape(overlay);

    // Fit after layout settles
    requestAnimationFrame(() => {
        requestAnimationFrame(() => _fitFsToContainer());
    });

    // Keep re-fitting as the real fullscreen/orientation transition catches
    // up (and for any later resize/rotation while the overlay stays open).
    if (!_fsRefitHandler) {
        _fsRefitHandler = () => {
            if (overlay.style.display === 'none') return;
            requestAnimationFrame(() => _fitFsToContainer());
        };
        window.addEventListener('resize', _fsRefitHandler);
        window.addEventListener('orientationchange', _fsRefitHandler);
        document.addEventListener('fullscreenchange', _fsRefitHandler);
        document.addEventListener('webkitfullscreenchange', _fsRefitHandler);
        if (screen.orientation && screen.orientation.addEventListener) {
            screen.orientation.addEventListener('change', _fsRefitHandler);
        }
    }
}

function _refreshFsContent() {
    if (!_fsPanelType) return;
    const scrollId = _fsScrollId(_fsPanelType);
    const srcScroll = document.getElementById(scrollId);
    const srcWrap   = srcScroll ? srcScroll.querySelector('.zoom-content-wrapper') : null;
    const fsScroll  = document.getElementById('panel-fs-scroll');
    if (!srcWrap || !fsScroll) return;
    const clone = srcWrap.cloneNode(true);
    clone.style.transition = 'none';
    clone.style.transform  = `translate3d(${_fsState.x}px, ${_fsState.y}px, 0) scale3d(${_fsState.scale}, ${_fsState.scale}, 1)`;
    fsScroll.innerHTML = '';
    fsScroll.appendChild(clone);
    clone.querySelectorAll('.sim-toggle').forEach(el => {
        el.style.pointerEvents = 'auto';
        el.addEventListener('click', () => {
            const varName = el.getAttribute('data-var');
            if (varName && typeof toggleSimInput === 'function') {
                toggleSimInput(varName);
                requestAnimationFrame(() => _refreshFsContent());
            }
        });
    });
}

function closePanelFullscreen() {
    const overlay = document.getElementById('panel-fullscreen-overlay');
    if (!overlay) return;
    _exitFsLandscape();
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    document.getElementById('panel-fs-scroll').innerHTML = '';
    _fsPanelType = null;
    _fsDragging  = false;
    _fsTouchDist = 0;

    if (_fsRefitHandler) {
        window.removeEventListener('resize', _fsRefitHandler);
        window.removeEventListener('orientationchange', _fsRefitHandler);
        document.removeEventListener('fullscreenchange', _fsRefitHandler);
        document.removeEventListener('webkitfullscreenchange', _fsRefitHandler);
        if (screen.orientation && screen.orientation.removeEventListener) {
            screen.orientation.removeEventListener('change', _fsRefitHandler);
        }
        _fsRefitHandler = null;
    }
}

// Wire up fullscreen overlay controls (runs once at startup)
(function initFsOverlay() {
    const overlay  = document.getElementById('panel-fullscreen-overlay');
    const fsScroll = document.getElementById('panel-fs-scroll');
    const btnIn    = document.getElementById('panel-fs-zoom-in');
    const btnOut   = document.getElementById('panel-fs-zoom-out');
    const btnExit  = document.getElementById('panel-fs-exit');
    if (!overlay || !fsScroll || !btnIn || !btnOut || !btnExit) return;

    btnIn.addEventListener('click', () => {
        const cw = fsScroll.clientWidth, ch = fsScroll.clientHeight;
        const oldScale = _fsState.scale;
        let newScale = Math.min(oldScale * 1.2, 6.0);
        const f = newScale / oldScale;
        _fsState.x = cw / 2 - (cw / 2 - _fsState.x) * f;
        _fsState.y = ch / 2 - (ch / 2 - _fsState.y) * f;
        _fsState.scale = newScale;
        _applyFsZoom(true);
        setTimeout(() => _forceCrispRepaint(fsScroll.querySelector('.zoom-content-wrapper')), 160);
    });

    btnOut.addEventListener('click', () => {
        const cw = fsScroll.clientWidth, ch = fsScroll.clientHeight;
        const oldScale = _fsState.scale;
        let newScale = Math.max(oldScale * 0.8, 0.05);
        const f = newScale / oldScale;
        _fsState.x = cw / 2 - (cw / 2 - _fsState.x) * f;
        _fsState.y = ch / 2 - (ch / 2 - _fsState.y) * f;
        _fsState.scale = newScale;
        _applyFsZoom(true);
        setTimeout(() => _forceCrispRepaint(fsScroll.querySelector('.zoom-content-wrapper')), 160);
    });

    btnExit.addEventListener('click', closePanelFullscreen);

    // Keyboard Escape to exit
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.style.display !== 'none') closePanelFullscreen();
    });

    // If the OS/browser exits fullscreen on its own (e.g. Android back
    // gesture), make sure our overlay + orientation lock don't get stuck.
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && overlay.style.display !== 'none') {
            closePanelFullscreen();
        }
    });

    // Mouse wheel zoom
    let _fsWheelSettleTimer = null;
    fsScroll.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = fsScroll.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const oldScale = _fsState.scale;
        let newScale = Math.max(0.05, Math.min(6.0, oldScale * factor));
        const f = newScale / oldScale;
        _fsState.x = px - (px - _fsState.x) * f;
        _fsState.y = py - (py - _fsState.y) * f;
        _fsState.scale = newScale;
        _applyFsZoom(false);
        clearTimeout(_fsWheelSettleTimer);
        _fsWheelSettleTimer = setTimeout(() => {
            _forceCrispRepaint(document.querySelector('#panel-fs-scroll .zoom-content-wrapper'));
        }, 120);
    }, { passive: false });

    // Mouse drag pan
    fsScroll.addEventListener('mousedown', (e) => {
        if (e.target.closest('.panel-fs-controls')) return;
        _fsDragging   = true;
        _fsDragStartX = e.clientX;
        _fsDragStartY = e.clientY;
        _fsInitX      = _fsState.x;
        _fsInitY      = _fsState.y;
        fsScroll.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => {
        _fsDragging = false;
        fsScroll.style.cursor = '';
        _forceCrispRepaint(document.querySelector('#panel-fs-scroll .zoom-content-wrapper'));
    });
    window.addEventListener('mousemove', (e) => {
        if (!_fsDragging) return;
        _fsState.x = _fsInitX + (e.clientX - _fsDragStartX);
        _fsState.y = _fsInitY + (e.clientY - _fsDragStartY);
        _applyFsZoom(false);
    });

    // Touch pan / pinch zoom
    fsScroll.addEventListener('touchstart', (e) => {
        if (e.target.closest('.panel-fs-controls')) return;
        if (e.touches.length === 1) {
            _fsDragging   = true;
            _fsDragStartX = e.touches[0].clientX;
            _fsDragStartY = e.touches[0].clientY;
            _fsInitX      = _fsState.x;
            _fsInitY      = _fsState.y;
        } else if (e.touches.length === 2) {
            e.preventDefault();
            _fsDragging = false;
            fsScroll._cachedRect = fsScroll.getBoundingClientRect();
            const x1 = e.touches[0].clientX - fsScroll._cachedRect.left, y1 = e.touches[0].clientY - fsScroll._cachedRect.top;
            const x2 = e.touches[1].clientX - fsScroll._cachedRect.left, y2 = e.touches[1].clientY - fsScroll._cachedRect.top;

            _fsTouchDist   = Math.hypot(x1 - x2, y1 - y2);
            _fsTouchMidX   = (x1 + x2) / 2;
            _fsTouchMidY   = (y1 + y2) / 2;
            _fsTouchZoom   = _fsState.scale;
            _fsTouchInitX  = _fsState.x;
            _fsTouchInitY  = _fsState.y;
        }
    }, { passive: false });

    fsScroll.addEventListener('touchend', () => {
        _fsDragging  = false;
        _fsTouchDist = 0;
        _forceCrispRepaint(document.querySelector('#panel-fs-scroll .zoom-content-wrapper'));
    });

    fsScroll.addEventListener('touchmove', (e) => {
        if (_fsDragging && e.touches.length === 1) {
            _fsState.x = _fsInitX + (e.touches[0].clientX - _fsDragStartX);
            _fsState.y = _fsInitY + (e.touches[0].clientY - _fsDragStartY);
            _applyFsZoom(false);
        } else if (e.touches.length === 2) {
            e.preventDefault();
            const rect = fsScroll._cachedRect || fsScroll.getBoundingClientRect();
            const x1 = e.touches[0].clientX - rect.left, y1 = e.touches[0].clientY - rect.top;
            const x2 = e.touches[1].clientX - rect.left, y2 = e.touches[1].clientY - rect.top;
            const dist = Math.hypot(x1 - x2, y1 - y2);
            const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
            if (_fsTouchDist === 0) {

                _fsTouchDist = dist; _fsTouchMidX = midX; _fsTouchMidY = midY;
                _fsTouchZoom = _fsState.scale; _fsTouchInitX = _fsState.x; _fsTouchInitY = _fsState.y;
                return;
            }
            const factor = dist / _fsTouchDist;
            let newScale = _fsTouchZoom * factor;
            
            const floor = _fsState.fitScale || 0.05;
            newScale = Math.max(floor, Math.min(6.0, newScale));
            
            // 2. Now calculate the X/Y safely
            _fsState.x = midX - (_fsTouchMidX - _fsTouchInitX) * (newScale / _fsTouchZoom);
            _fsState.y = midY - (_fsTouchMidY - _fsTouchInitY) * (newScale / _fsTouchZoom);
            _fsState.scale = newScale;
            
            _applyFsZoom(false);
        }
    }, { passive: false });
})();

function generateSVGForCircuit(root) {
    let leafY = 40;
    const ySpacing = 60;
    
    function layoutNode(node, depth) {
        if (!node.children || node.children.length === 0) {
            node.x = 40;
            node.y = leafY;
            leafY += ySpacing;
        } else {
            let sumY = 0;
            let maxX = 0;
            node.children.forEach(child => {
                layoutNode(child, depth + 1);
                sumY += child.y;
                const childR = !child.isGate ? 20 : (child.children.length === 3 ? 25 : (child.children.length === 4 ? 30 : (child.children.length > 4 ? 35 : 20)));
                const childOutputX = child.x + childR;
                if (childOutputX > maxX) maxX = childOutputX;
            });
            node.x = maxX + 65;
            
            const numC = node.children.length;
            if (numC === 2) {
                node.y = (node.children[0].y + node.children[1].y) / 2;
            } else if (numC === 3) {
                node.y = node.children[1].y;
            } else if (numC === 4) {
                node.y = (node.children[1].y + node.children[2].y) / 2;
            } else {
                node.y = sumY / numC;
            }
        }
    }
    
    layoutNode(root, 0);
    
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    function findBounds(node) {
        if (node.x < minX) minX = node.x;
        if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.y > maxY) maxY = node.y;
        if (node.children) {
            node.children.forEach(findBounds);
        }
    }
    findBounds(root);
    maxX = Math.max(maxX, root.x + 130);
    
    const padding = 40;
    // Natural content size before the 300x200 floor is applied.
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;
    const width = Math.max(contentW, 300);
    const height = Math.max(contentH, 200);
    // If the enforced minimum is bigger than the natural content, split that
    // extra space evenly on both sides instead of only appending it to the
    // right/bottom - otherwise small circuits sit visibly off-center inside
    // their own SVG box even after the box itself is centered in the panel.
    const extraX = (width - contentW) / 2;
    const extraY = (height - contentH) / 2;
    const dx = padding - minX + extraX;
    const dy = padding - minY + extraY;
    
    function shiftNodes(node) {
        node.x += dx;
        node.y += dy;
        if (node.children) {
            node.children.forEach(shiftNodes);
        }
    }
    shiftNodes(root);
    
    let svg = `<div class="zoom-content-wrapper" style="width: ${width}px; height: ${height}px;">`;
    svg += `<svg class="circuit-svg" viewBox="0 0 ${width} ${height}">`;
    
    let wires = '';
    let gates = '';
    
    function drawNode(node) {
        if (node.children) {
            // Sort children so wires don't criss-cross weirdly, though tree layout naturally handles it somewhat
            node.children.forEach((child, idx) => {
                const childR = !child.isGate ? 20 : (child.children.length === 3 ? 25 : (child.children.length === 4 ? 30 : (child.children.length > 4 ? 35 : 20)));
                const cx = child.x + childR; // output of child
                
                // input of current node
                let nx = node.x - 20; 
                if (node.type === 'OR') nx = node.x - 15;
                if (node.type === 'NOT') nx = node.x - 15;
                
                let ny = node.y;
                if (node.children.length > 1) {
                    // Spread inputs vertically
                    const numInputs = node.children.length;
                    const span = numInputs === 3 ? 30 : (numInputs === 4 ? 40 : (numInputs > 4 ? 50 : 20));
                    const step = span / (numInputs - 1);
                    ny = node.y - span/2 + idx * step;
                }
                
                const cy = child.y;
                
                let midX = Math.max(cx + 10, nx - 22);
                if (node.children.length === 4 && (idx === 1 || idx === 2)) {
                    midX = Math.max(cx + 5, nx - 38);
                }
                wires += `<path class="circuit-wire" d="M ${cx} ${cy} L ${midX} ${cy} L ${midX} ${ny} L ${nx} ${ny}" />`;
                
                drawNode(child);
            });
        }
        
        if (!node.isGate) {
            gates += `<circle class="var-node" cx="${node.x}" cy="${node.y}" r="20" />`;
            // dy value below is not a generic guess - it's the measured vertical
            // offset for this exact font (Outfit Bold): rendered the glyph,
            // measured its actual ink bounding box, and computed the exact shift
            // needed to align its visual center (not its alphabetic baseline)
            // with the circle's center. 0.35em (the generic rule-of-thumb) was
            // still measurably too small a shift and left the glyph sitting high.
            gates += `<text class="var-text" x="${node.x}" y="${node.y}" text-anchor="middle" dy="0.244em">${node.value}</text>`;
        } else {
            gates += getGateSVG(node.type, node.x, node.y, node.children ? node.children.length : 2);
        }
    }
    
    drawNode(root);
    
    // Output wire
    const rootR = !root.isGate ? 20 : (root.children.length === 3 ? 25 : (root.children.length === 4 ? 30 : (root.children.length > 4 ? 35 : 20)));
    wires += `<path class="circuit-wire" d="M ${root.x + rootR} ${root.y} L ${root.x + rootR + 35} ${root.y}" />`;
    gates += `<text class="var-text" x="${root.x + rootR + 45}" y="${root.y}" text-anchor="start" dominant-baseline="central">OUTPUT</text>`;
    svg += wires;
    svg += gates;
    svg += `</svg></div>`;
    return svg;
}

function getGateSVG(type, x, y, numInputs = 2) {
    let svg = '';
    let r = 20;
    if (numInputs === 3) r = 25;
    else if (numInputs === 4) r = 30;
    else if (numInputs > 4) r = 35;

    if (type === 'AND') {
        svg += `<path class="gate-shape" d="M ${x-20} ${y-r} L ${x} ${y-r} A ${r} ${r} 0 0 1 ${x} ${y+r} L ${x-20} ${y+r} Z" />`;
    } else if (type === 'OR') {
        svg += `<path class="gate-shape" d="M ${x-20} ${y-r} Q ${x-5} ${y} ${x-20} ${y+r} Q ${x+10} ${y+r} ${x+r} ${y} Q ${x+10} ${y-r} ${x-20} ${y-r} Z" />`;
    } else if (type === 'NOT') {
        svg += `<path class="gate-shape" d="M ${x-15} ${y-15} L ${x+10} ${y} L ${x-15} ${y+15} Z" />`;
        svg += `<circle class="gate-shape" cx="${x+15}" cy="${y}" r="5" />`;
    }
    return svg;
}

function initPanAndZoom(containerId, panelType) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // Clean up existing observer on this element
    if (container._resizeObserver) {
        container._resizeObserver.disconnect();
    }
    
    const observer = new ResizeObserver((entries) => {
        for (let entry of entries) {
            if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                fitToContainer(panelType);
            }
        }
    });
    observer.observe(container);
    container._resizeObserver = observer;
    
    let isDragging = false;
    let startX, startY;
    let initialX, initialY;
    
    // Mouse drag to pan
    container.addEventListener('mousedown', (e) => {
        if (e.target.closest('.zoom-controls')) return;
        isDragging = true;
        container.style.cursor = 'grabbing';
        startX = e.clientX;
        startY = e.clientY;
        initialX = panelsState[panelType].x;
        initialY = panelsState[panelType].y;
    });
    
    container.addEventListener('mouseleave', () => {
        isDragging = false;
        container.style.cursor = 'default';
    });
    
    container.addEventListener('mouseup', () => {
        isDragging = false;
        container.style.cursor = 'default';
        const wrap = container.querySelector('.zoom-content-wrapper');
        _forceCrispRepaint(wrap);
    });
    
    container.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panelsState[panelType].x = initialX + dx;
        panelsState[panelType].y = initialY + dy;
        applyZoom(panelType, false);
    });
    
    // Mouse wheel to zoom at cursor position
    let _wheelSettleTimer = null;
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        zoomAtPoint(panelType, factor, px, py, false);
        // Debounce: once wheel events stop arriving for a beat, the gesture
        // has settled — force a fresh rasterization at the final scale so
        // we're not left showing a GPU-stretched bitmap from mid-scroll.
        clearTimeout(_wheelSettleTimer);
        _wheelSettleTimer = setTimeout(() => {
            _forceCrispRepaint(container.querySelector('.zoom-content-wrapper'));
        }, 120);
    }, { passive: false });
    
    // Touch events for drag panning and pinch zoom
    let touchStartDist = 0;
    let startZoom = 1.0;
    let startMidX = 0, startMidY = 0;
    let containerRect = null;
    container.addEventListener('touchstart', (e) => {
        if (e.target.closest('.zoom-controls')) return;
        if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            initialX = panelsState[panelType].x;
            initialY = panelsState[panelType].y;
        } else if (e.touches.length === 2) {
            e.preventDefault();
            isDragging = false;
            container._cachedRect = container.getBoundingClientRect();
            const x1 = e.touches[0].clientX - container._cachedRect.left;
            const y1 = e.touches[0].clientY - container._cachedRect.top;
            const x2 = e.touches[1].clientX - container._cachedRect.left;
            const y2 = e.touches[1].clientY - container._cachedRect.top;
            
            touchStartDist = Math.hypot(x1 - x2, y1 - y2);
            startMidX = (x1 + x2) / 2;
            startMidY = (y1 + y2) / 2;
            // panelsState is always kept in sync by fitToContainer/applyZoom — read directly
            startZoom = panelsState[panelType].scale;
            initialX  = panelsState[panelType].x;
            initialY  = panelsState[panelType].y;
        }
    }, { passive: false });
    
    container.addEventListener('touchend', (e) => {
        isDragging = false;
        // A pinch or drag just ended. Continuous touchmove updates use
        // smooth=false for responsiveness, which leaves the SVG on a
        // GPU-stretched raster from mid-gesture — force a fresh, crisp
        // rasterization at the final settled scale now that it's done.
        if (touchStartDist > 0 && e.touches.length < 2) {
            touchStartDist = 0;
        }
        _forceCrispRepaint(container.querySelector('.zoom-content-wrapper'));
    });
    
    container.addEventListener('touchmove', (e) => {
        if (isDragging && e.touches.length === 1) {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            panelsState[panelType].x = initialX + dx;
            panelsState[panelType].y = initialY + dy;
            applyZoom(panelType, false);
        } else if (e.touches.length === 2) {
            e.preventDefault();
            const rect = container._cachedRect || container.getBoundingClientRect();
            const x1 = e.touches[0].clientX - rect.left;
            const y1 = e.touches[0].clientY - rect.top;
            const x2 = e.touches[1].clientX - rect.left;
            const y2 = e.touches[1].clientY - rect.top;
            
            const dist = Math.hypot(x1 - x2, y1 - y2);
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            
            // Guard: second finger added during move without a proper 2-finger touchstart
            if (touchStartDist === 0) {
                touchStartDist = dist;
                startMidX = midX;
                startMidY = midY;
                startZoom = panelsState[panelType].scale;
                initialX  = panelsState[panelType].x;
                initialY  = panelsState[panelType].y;
                return;
            }
            
            const factor = dist / touchStartDist;
            let newScale = startZoom * factor;
            
            // 1. Apply the floor limit BEFORE calculating X and Y
            const floor = panelsState[panelType].fitScale || 0.05;
            newScale = Math.max(floor, Math.min(4.0, newScale));
            
            // 2. Now calculate the X/Y safely
            panelsState[panelType].x = midX - (startMidX - initialX) * (newScale / startZoom);
            panelsState[panelType].y = midY - (startMidY - initialY) * (newScale / startZoom);
            panelsState[panelType].scale = newScale;
            
            applyZoom(panelType, false);
        }
    }, { passive: false });
}

function exportSvgToPng(svgElement, filename) {
    if (!svgElement) return;
    
    const viewBox = svgElement.getAttribute('viewBox');
    let width = 800;
    let height = 600;
    if (viewBox) {
        const parts = viewBox.split(' ');
        width = parseFloat(parts[2]) || 800;
        height = parseFloat(parts[3]) || 600;
    }
    
    const exportScale = 2.0;
    const canvas = document.createElement('canvas');
    canvas.width = width * exportScale;
    canvas.height = height * exportScale;
    const ctx = canvas.getContext('2d');
    
    const rootStyle = getComputedStyle(document.documentElement);
    const textPrimary = rootStyle.getPropertyValue('--text-primary').trim() || '#f8fafc';
    const bgSecondary = rootStyle.getPropertyValue('--bg-secondary').trim() || '#1e293b';
    
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .circuit-wire { fill: none; stroke: ${textPrimary}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
        .gate-shape { fill: none; stroke: ${textPrimary}; stroke-width: 2.5; }
        .var-node { fill: none; stroke: ${textPrimary}; stroke-width: 2.5; }
        .var-text { font-family: Outfit, sans-serif; font-size: 16px; font-weight: 700; fill: ${textPrimary}; }
        .gate-text { font-family: Outfit, sans-serif; font-size: 14px; fill: ${textPrimary}; font-weight: 600; }
    `;
    
    const clonedSvg = svgElement.cloneNode(true);
    clonedSvg.appendChild(styleEl);
    
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clonedSvg);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    
    const img = new Image();
    img.onload = () => {
        ctx.fillStyle = bgSecondary;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.scale(exportScale, exportScale);
        ctx.drawImage(img, 0, 0, width, height);
        
        const pngUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = pngUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast('Circuit exported as PNG!');
    };
    img.onerror = (err) => {
        console.error('Failed to render SVG image for PNG export:', err);
        showToast('Export failed', 'error');
    };
    img.src = url;
}


// ==========================================
// PCB SIMULATION ENGINE
// ==========================================


// Layout cache populated by generateSVGForSimulation on every full render
// (new expression, resetZoom). Keyed by panelId ('o' / 's'). toggleSimInput
// reads from this instead of re-walking the circuit tree.
const _simLayoutCache = {};

function toggleSimInput(varName) {
    simInputStates[varName] = !simInputStates[varName];

    // Fast path: the circuit shape hasn't changed, only variable states —
    // restyle the ~10-20 affected elements (LED/status-dot colors, trace
    // colors, cap position) directly instead of regenerating and re-parsing
    // thousands of characters of SVG markup for both panels.
    const updatedOrig = updateSimulationColors('o', 'original-sim-scroll');
    const updatedSimp = updateSimulationColors('s', 'simplified-sim-scroll');

    // Fallback for anything the fast path couldn't handle (e.g. no cached
    // layout yet, or the panel's SVG isn't in the DOM) — do a full rebuild.
    if (!updatedOrig && !updatedSimp) {
        renderHTMLSimulation(false);
    }
}
window.toggleSimInput = toggleSimInput; // Expose for events

/**
 * Restyle an already-rendered simulation panel to reflect the current
 * simInputStates, without recomputing layout or regenerating SVG markup.
 * Returns false (and does nothing) if there's no cached layout or the
 * panel's SVG isn't currently in the DOM, so the caller can fall back to
 * a full render.
 */
function updateSimulationColors(panelId, scrollElId) {
    const cache = _simLayoutCache[panelId];
    if (!cache) return false;
    const scrollEl = document.getElementById(scrollElId);
    if (!scrollEl || !scrollEl.querySelector('svg')) return false;

    const { root, posMap, dx, dy } = cache;

    // Same index sequence generateSVGForSimulation used when it built the ids
    // (copper-traces loop and components loop both walk posMap in this same
    // order, starting at 0), so idx here lines up with the ids in the DOM.
    let idx = 0;
    for (const [node, pos] of posMap.entries()) {
        const myIdx = idx++;
        const y = pos.y + dy;
        const state = evaluateSimLogic(node);

        if (!node.isGate) {
            const isConst = node.value === '0' || node.value === '1';
            if (!isConst) {
                const cap = document.getElementById(`toggle-cap-${panelId}-${myIdx}`);
                if (cap) cap.setAttribute('cy', state ? y : y - 4);
                const dot = document.getElementById(`toggle-dot-${panelId}-${myIdx}`);
                if (dot) dot.setAttribute('fill', state ? '#30d158' : '#ff453a');
            }
            continue;
        }

        const gateDot = document.getElementById(`gate-dot-${panelId}-${myIdx}`);
        if (gateDot) {
            if (state) {
                gateDot.setAttribute('fill', '#60ff60');
                gateDot.setAttribute('filter', `url(#led-glow-small-${panelId})`);
            } else {
                gateDot.setAttribute('fill', '#113311');
                gateDot.removeAttribute('filter');
            }
        }

        if (node.children) {
            for (let i = 0; i < node.children.length; i++) {
                const childState = evaluateSimLogic(node.children[i]);
                const trace = document.getElementById(`trace-${panelId}-${myIdx}-${i}`);
                if (!trace) continue;
                if (childState) {
                    trace.setAttribute('stroke', '#4ade80');
                    trace.setAttribute('filter', `url(#trace-3d-active-${panelId})`);
                } else {
                    trace.setAttribute('stroke', '#154c27');
                    trace.setAttribute('filter', `url(#trace-3d-inactive-${panelId})`);
                }
            }
        }
    }

    // Output trace + LED
    const finalState = evaluateSimLogic(root);
    const outTrace = document.getElementById(`output-trace-${panelId}`);
    if (outTrace) {
        if (finalState) {
            outTrace.setAttribute('stroke', '#4ade80');
            outTrace.setAttribute('filter', `url(#trace-3d-active-${panelId})`);
        } else {
            outTrace.setAttribute('stroke', '#154c27');
            outTrace.setAttribute('filter', `url(#trace-3d-inactive-${panelId})`);
        }
    }
    const ledBase = document.getElementById(`led-base-${panelId}`);
    if (ledBase) ledBase.setAttribute('fill', finalState ? '#882200' : '#220000');
    const ledDome = document.getElementById(`led-dome-${panelId}`);
    if (ledDome) ledDome.setAttribute('fill', `url(#${finalState ? 'led-on' : 'led-off'}-${panelId})`);
    const ledGlow = document.getElementById(`led-glow-circle-${panelId}`);
    if (ledGlow) ledGlow.setAttribute('opacity', finalState ? '0.35' : '0');

    return true;
}

function evaluateSimLogic(node) {
    if (!node) return false;
    if (!node.isGate) {
        if (node.value === '1') return true;
        if (node.value === '0') return false;
        return !!simInputStates[node.value];
    }
    const gateType = node.type;
    const childrenVals = node.children ? node.children.map(evaluateSimLogic) : [];
    
    if (gateType === 'NOT') return !childrenVals[0];
    if (gateType === 'AND') return childrenVals.every(v => v);
    if (gateType === 'OR') return childrenVals.some(v => v);
    if (gateType === 'NAND') return !childrenVals.every(v => v);
    if (gateType === 'NOR') return !childrenVals.some(v => v);
    if (gateType === 'XOR') {
        const sum = childrenVals.reduce((acc, curr) => acc + (curr ? 1 : 0), 0);
        return sum % 2 === 1;
    }
    if (gateType === 'XNOR') {
        const sum = childrenVals.reduce((acc, curr) => acc + (curr ? 1 : 0), 0);
        return sum % 2 === 0;
    }
    return false;
}

function renderHTMLSimulation(resetZoom = true) {
    const origSimScroll = document.getElementById('original-sim-scroll');
    const simpSimScroll = document.getElementById('simplified-sim-scroll');
    const container = document.getElementById('simulation-container');
    const origSimPanel = document.getElementById('original-sim-panel');
    if (!origSimScroll || !simpSimScroll || !container) return;
    
    const jsonStr = queryWasmString('mantiq_getCircuitJSON');
    console.log("Mantiq Debug - Simulation JSON:", jsonStr);
    if (!jsonStr) {
        origSimScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No expression processed yet</div>';
        simpSimScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No expression processed yet</div>';
        return;
    }
    
    let circuitData;
    try {
        circuitData = JSON.parse(jsonStr);
    } catch(e) {
        origSimScroll.innerHTML = '<div style="color:var(--error); text-align:center;">Error parsing circuit data</div>';
        simpSimScroll.innerHTML = '<div style="color:var(--error); text-align:center;">Error parsing circuit data</div>';
        return;
    }
    
    const isDummy = !circuitData.original || (!circuitData.original.isGate && circuitData.original.value === 'dummy');

    container.classList.toggle('single-panel-view', isDummy);

    if (isDummy) {
        origSimPanel.style.display = 'none';
        container.style.gridTemplateColumns = '1fr';
        origSimScroll.innerHTML = '';
    } else {
        origSimPanel.style.display = 'flex';
        container.style.gridTemplateColumns = '1fr 1fr';
    }
    
    const initializeInputs = (n) => {
        if (!n.isGate && n.value !== '0' && n.value !== '1') {
            if (simInputStates[n.value] === undefined) simInputStates[n.value] = false;
        }
        if (n.children) n.children.forEach(initializeInputs);
    };
    const origDepth = getGateDepth(circuitData.original);
    const simpDepth = getGateDepth(circuitData.simplified);

    if (resetZoom) {
        simInputStates = {}; 
        if (!isDummy && origDepth <= 99) initializeInputs(circuitData.original);
        if (circuitData.simplified && simpDepth <= 99) initializeInputs(circuitData.simplified);
    }
    
    // Helper: inject SVG content directly — same pattern as circuit diagram.
    // fitToContainer via requestAnimationFrame positions it correctly before first paint.
    const injectSVG = (scrollEl, html) => {
        scrollEl.innerHTML = '';
        const ghost = document.createElement('div');
        ghost.innerHTML = html;
        const newWrapper = ghost.firstElementChild;
        if (newWrapper) scrollEl.appendChild(newWrapper);
    };

    // Render original simulation if not dummy
    if (!isDummy) {
        if (origDepth > 99) { // Setting 99 to disable 10-level limit for original circuit
            origSimScroll.innerHTML = '<div class="exceeded-msg">Original simulation exceeds 99 levels of gates.</div>';
        } else {
            injectSVG(origSimScroll, generateSVGForSimulation(circuitData.original, 'o'));
        }
    }
    
    // Render simplified simulation if available
    if (simpDepth > 99) { // Setting 99 to disable 10-level limit for simplified circuit
        simpSimScroll.innerHTML = '<div class="exceeded-msg">Simplified simulation exceeds 99 levels of gates.</div>';
    } else if (circuitData.simplified) {
        injectSVG(simpSimScroll, generateSVGForSimulation(circuitData.simplified, 's'));
    } else {
        simpSimScroll.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20px;">No simplified circuit</div>';
    }
    
    // Attach click listeners to all toggles in both panels
    const attachToggles = (scrollEl) => {
        const toggles = scrollEl.querySelectorAll('.sim-toggle');
        toggles.forEach(t => {
            t.addEventListener('click', () => toggleSimInput(t.getAttribute('data-var')));
        });
    };
    
if (!isDummy && origDepth <= 99) attachToggles(origSimScroll);
    if (simpDepth <= 99) attachToggles(simpSimScroll);
    
    if (!isDummy && origDepth <= 99) {
        const firstInit = !container.dataset.zoomOrigInitialized;
        if (resetZoom || firstInit) {
            // Fit synchronously first - same tick as injectSVG above, before the
            // browser paints - so a new expression's board swaps in already at
            // the correct size instead of flashing full-size then shrinking.
            fitToContainer('simOrig');
            centerPanel('simOrig');
        } else {
            // Toggle or expression change on an already-initialized panel:
            // injectSVG() built a fresh .zoom-content-wrapper — clear the stale
            // layout cache so we don't apply the zoom to the old, detached element!
            delete _metricsCache['simOrig'];
            
            const m = _measureMetrics('simOrig');
            if (m && _contentSizeChanged('simOrig', m.w, m.h)) {
                fitToContainer('simOrig');
                centerPanel('simOrig');
            } else {
                requestAnimationFrame(() => {
                    applyZoom('simOrig', false);
                    _forceCrispRepaint(m.contentEl); // Forces mobile to paint the new SVG
                });
            }
        }
        if (firstInit) {

            initPanAndZoom('original-sim-scroll', 'simOrig');
            container.dataset.zoomOrigInitialized = 'true';

            const origSimPanel = document.getElementById('original-sim-panel');
            document.getElementById('zoom-in-sim-orig').onclick = () => zoomAtPoint('simOrig', 1.15, origSimPanel.clientWidth / 2, origSimPanel.clientHeight / 2, true);
            document.getElementById('zoom-out-sim-orig').onclick = () => zoomAtPoint('simOrig', 0.85, origSimPanel.clientWidth / 2, origSimPanel.clientHeight / 2, true);
            document.getElementById('zoom-fullscreen-sim-orig').onclick = () => openPanelFullscreen('simOrig');
        }
    }

    if (simpDepth <= 99 && circuitData.simplified) {
        const firstInit = !container.dataset.zoomSimpInitialized;
        if (resetZoom || firstInit) {
            fitToContainer('simSimp');
            centerPanel('simSimp');
        } else {
                delete _metricsCache['simSimp'];
                
                const m = _measureMetrics('simSimp');
                if (m && _contentSizeChanged('simSimp', m.w, m.h)) {
                    fitToContainer('simSimp');
                    centerPanel('simSimp');
                } else {
                    requestAnimationFrame(() => {
                        applyZoom('simSimp', false);
                        _forceCrispRepaint(m.contentEl); // Forces mobile to paint the new SVG
                    });
                }
            }
            if (firstInit) {
            const simpSimPanel = document.getElementById('simplified-sim-panel');
            if (simpSimPanel) {
                initPanAndZoom('simplified-sim-scroll', 'simSimp');
                container.dataset.zoomSimpInitialized = 'true';

                document.getElementById('zoom-in-sim-simp').onclick = () => zoomAtPoint('simSimp', 1.15, simpSimPanel.clientWidth / 2, simpSimPanel.clientHeight / 2, true);
                document.getElementById('zoom-out-sim-simp').onclick = () => zoomAtPoint('simSimp', 0.85, simpSimPanel.clientWidth / 2, simpSimPanel.clientHeight / 2, true);
                document.getElementById('zoom-fullscreen-sim-simp').onclick = () => openPanelFullscreen('simSimp');
            }
        }
    }
}

function getGateOutputPinRange(type, x, numInputs = 2) {
    if (type === 'NOT') {
        return { startX: x + 22, endX: x + 34 };
    }
    let r = 25;
    if (numInputs === 3) r = 30;
    else if (numInputs === 4) r = 35;
    else if (numInputs > 4) r = 40;

    if (type === 'NAND' || type === 'NOR') {
        return { startX: x + r + 10, endX: x + r + 22 };
    }
    return { startX: x + r, endX: x + r + 12 }; // AND, OR, default
}

function getSimGateSilkscreen(type, x, y, panelId = 'p', numInputs = 2) {
    let inner = '';
    const offset = 2.5; // Offset to draw silkscreen slightly outside the gate body
    let r = 25;
    if (numInputs === 3) r = 30;
    else if (numInputs === 4) r = 35;
    else if (numInputs > 4) r = 40;

    const ro = r + offset;

    if (type === 'AND') {
        inner = `<path d="M ${x-25-offset} ${y-ro} L ${x} ${y-ro} A ${ro} ${ro} 0 0 1 ${x} ${y+ro} L ${x-25-offset} ${y+ro} Z" />`;
    } else if (type === 'OR') {
        inner = `<path d="M ${x-25-offset} ${y-ro} Q ${x-8} ${y} ${x-25-offset} ${y+ro} Q ${x+10+offset} ${y+ro} ${x+ro} ${y} Q ${x+10+offset} ${y-ro} ${x-25-offset} ${y-ro} Z" />`;
    } else if (type === 'NOT') {
        inner = `<path d="M ${x-20-offset} ${y-20-offset} L ${x+10+offset} ${y} L ${x-20-offset} ${y+20+offset} Z" />
                 <circle cx="${x+16}" cy="${y}" r="${6+offset}" />`;
    } else if (type === 'NAND') {
        inner = `<path d="M ${x-25-offset} ${y-ro} L ${x} ${y-ro} A ${ro} ${ro} 0 0 1 ${x} ${y+ro} L ${x-25-offset} ${y+ro} Z" />
                 <circle cx="${x+r+5}" cy="${y}" r="${5+offset}" />`;
    } else if (type === 'NOR') {
        inner = `<path d="M ${x-25-offset} ${y-ro} Q ${x-8} ${y} ${x-25-offset} ${y+ro} Q ${x+10+offset} ${y+ro} ${x+ro} ${y} Q ${x+10+offset} ${y-ro} ${x-25-offset} ${y-ro} Z" />
                 <circle cx="${x+r+5}" cy="${y}" r="${5+offset}" />`;
    } else {
        inner = `<rect x="${x-25-offset}" y="${y-ro}" width="${50+offset*2}" height="${r*2+offset*2}" rx="4" />`;
    }
    return `<g fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.6" filter="url(#silkscreen-${panelId})">${inner}</g>`;
}

function getSimGateShape(type, x, y, panelId = 'p', numInputs = 2) {
    let inner = '';
    let r = 25;
    if (numInputs === 3) r = 30;
    else if (numInputs === 4) r = 35;
    else if (numInputs > 4) r = 40;

    if (type === 'AND') {
        inner = `<path d="M ${x-25} ${y-r} L ${x} ${y-r} A ${r} ${r} 0 0 1 ${x} ${y+r} L ${x-25} ${y+r} Z" />`;
    } else if (type === 'OR') {
        inner = `<path d="M ${x-25} ${y-r} Q ${x-8} ${y} ${x-25} ${y+r} Q ${x+10} ${y+r} ${x+r} ${y} Q ${x+10} ${y-r} ${x-25} ${y-r} Z" />`;
    } else if (type === 'NOT') {
        inner = `<path d="M ${x-20} ${y-20} L ${x+10} ${y} L ${x-20} ${y+20} Z" />
                 <circle cx="${x+16}" cy="${y}" r="6" />`;
    } else if (type === 'NAND') {
        inner = `<path d="M ${x-25} ${y-r} L ${x} ${y-r} A ${r} ${r} 0 0 1 ${x} ${y+r} L ${x-25} ${y+r} Z" />
                 <circle cx="${x+r+5}" cy="${y}" r="5" />`;
    } else if (type === 'NOR') {
        inner = `<path d="M ${x-25} ${y-r} Q ${x-8} ${y} ${x-25} ${y+r} Q ${x+10} ${y+r} ${x+r} ${y} Q ${x+10} ${y-r} ${x-25} ${y-r} Z" />
                 <circle cx="${x+r+5}" cy="${y}" r="5" />`;
    } else {
        inner = `<rect x="${x-25}" y="${y-r}" width="50" height="${r*2}" rx="4" />`;
    }
    
    return `<g fill="#111111" filter="url(#plastic-3d-${panelId})">${inner}</g>`;
}

function generateSVGForSimulation(root, panelId = 'p') {
    if (!root) return '';
    
    const levelMap = new Map();
    function computeDepth(node) {
        if (!node.isGate) {
            levelMap.set(node, 0);
            return 0;
        }
        let maxChildDepth = -1;
        if (node.children) {
            for (const child of node.children) {
                maxChildDepth = Math.max(maxChildDepth, computeDepth(child));
            }
        }
        const d = maxChildDepth + 1;
        levelMap.set(node, d);
        return d;
    }
    computeDepth(root);
    
    const depthGroups = [];
    for (const [node, d] of levelMap.entries()) {
        while (depthGroups.length <= d) depthGroups.push([]);
        depthGroups[d].push(node);
    }
    
    const spacingY = 55;
    const posMap = new Map(); 
    
    if (depthGroups[0]) {
        for (let i = 0; i < depthGroups[0].length; i++) {
            posMap.set(depthGroups[0][i], { x: 0, y: i * spacingY });
        }
    }
    
    function getNodeWidth(n) {
        if (!n.isGate) return 24;
        const numInputs = n.children ? n.children.length : 2;
        let r = 25;
        if (numInputs === 3) r = 30;
        else if (numInputs === 4) r = 35;
        else if (numInputs > 4) r = 40;
        return r + 12;
    }

    const levelX = [0];
    for (let d = 1; d < depthGroups.length; d++) {
        let maxRight = 0;
        for (const prevNode of depthGroups[d-1]) {
            const prevPos = posMap.get(prevNode);
            if (prevPos) {
                const w = getNodeWidth(prevNode);
                if (prevPos.x + w > maxRight) {
                    maxRight = prevPos.x + w;
                }
            }
        }
        levelX[d] = maxRight + 65; // 65px clearance for trace + parent input pin

        for (const node of depthGroups[d]) {
            if (node.children) {
                const numC = node.children.length;
                let targetY = 0;
                if (numC === 2) {
                    targetY = (posMap.get(node.children[0]).y + posMap.get(node.children[1]).y) / 2;
                } else if (numC === 3) {
                    targetY = posMap.get(node.children[1]).y;
                } else if (numC === 4) {
                    targetY = (posMap.get(node.children[1]).y + posMap.get(node.children[2]).y) / 2;
                } else {
                    let sumY = 0;
                    for (const child of node.children) sumY += posMap.get(child).y;
                    targetY = sumY / numC;
                }
                posMap.set(node, { x: levelX[d], y: targetY });
            }
        }
    }
    for (let d = 1; d < depthGroups.length; d++) {
        depthGroups[d].sort((a, b) => posMap.get(a).y - posMap.get(b).y);
        for (let i = 1; i < depthGroups[d].length; i++) {
            const prev = posMap.get(depthGroups[d][i-1]);
            const curr = posMap.get(depthGroups[d][i]);
            if (curr.y < prev.y + spacingY) curr.y = prev.y + spacingY;
        }
    }
    
    let contentMinX = Infinity;
    let contentMaxX = -Infinity;
    let contentMinY = Infinity;
    let contentMaxY = -Infinity;
    
    for (const [node, pos] of posMap.entries()) {
        let left = pos.x;
        let right = pos.x;
        let top = pos.y;
        let bottom = pos.y;
        
        if (!node.isGate) {
            const isConst = node.value === '0' || node.value === '1';
            if (isConst) {
                left = pos.x - 18;
                right = pos.x + 18;
                top = pos.y - 18;
                bottom = pos.y + 32;
            } else {
                left = pos.x - 65; // label at x-35, end-aligned
                right = pos.x + 24;
                top = pos.y - 24;
                bottom = pos.y + 24;
            }
        } else {
            left = pos.x - 35;
            right = getGateOutputPinRange(node.type, pos.x, node.children ? node.children.length : 2).endX;
            top = pos.y - 28;
            bottom = pos.y + 25;
        }
        
        if (node === root) {
            const rootOutX = root.isGate ? getGateOutputPinRange(root.type, pos.x, root.children ? root.children.length : 2).endX : pos.x;
            const extraOutLen = root.isGate ? 0 : 80;
            const ledX = rootOutX + 40 + extraOutLen; 
            right = ledX + 25;
            bottom = Math.max(bottom, pos.y + 35);
        }
        
        contentMinX = Math.min(contentMinX, left);
        contentMaxX = Math.max(contentMaxX, right);
        contentMinY = Math.min(contentMinY, top);
        contentMaxY = Math.max(contentMaxY, bottom);
    }
    
    const pcbPadding = 50; 
    const width = (contentMaxX - contentMinX) + pcbPadding * 2;
    const height = (contentMaxY - contentMinY) + pcbPadding * 2;
    const dx = pcbPadding - contentMinX;
    const dy = pcbPadding - contentMinY;
    
    let svgContent = `
        <defs>
            <!-- Copper pad holes -->
            <pattern id="pcb-holes-${panelId}" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="10" cy="10" r="1.5" fill="#051005" opacity="0.8"/>
            </pattern>

            <!-- Metallic pin/leg -->
            <linearGradient id="metal-pin-${panelId}" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#888" />
                <stop offset="30%" stop-color="#ddd" />
                <stop offset="70%" stop-color="#555" />
                <stop offset="100%" stop-color="#333" />
            </linearGradient>

            <!-- Golden Plated Copper Pad -->
            <linearGradient id="metal-pad-${panelId}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ffe680" />
                <stop offset="50%" stop-color="#d4af37" />
                <stop offset="100%" stop-color="#aa8011" />
            </linearGradient>

            <!-- 3D Bevel & Shadow for IC plastic bodies -->
            <filter id="plastic-3d-${panelId}" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur"/>
                <feSpecularLighting in="blur" surfaceScale="3" specularConstant="0.8" specularExponent="25" lighting-color="#ffffff" result="specOut">
                    <fePointLight x="-2000" y="-2000" z="1000"/>
                </feSpecularLighting>
                <feComposite in="specOut" in2="SourceAlpha" operator="in" result="specOut"/>
                <feComposite in="SourceGraphic" in2="specOut" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="litPaint"/>
                <feDropShadow dx="3" dy="5" stdDeviation="4" flood-color="#000" flood-opacity="0.8"/>
            </filter>

            <!-- 3D Bevel for Button Caps (rounded, smooth) -->
            <filter id="btn-cap-3d-${panelId}" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur"/>
                <feSpecularLighting in="blur" surfaceScale="4" specularConstant="1.2" specularExponent="15" lighting-color="#ffffff" result="specOut">
                    <fePointLight x="-50" y="-50" z="50"/>
                </feSpecularLighting>
                <feComposite in="specOut" in2="SourceAlpha" operator="in" result="specOut"/>
                <feComposite in="SourceGraphic" in2="specOut" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="litPaint"/>
                <feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#000" flood-opacity="0.8"/>
            </filter>

            <!-- Active Trace 3D (Glowing Green PCB Wire) -->
            <!-- userSpaceOnUse, not bbox-relative: a straight horizontal trace
                 (e.g. the single input into a NOT gate) has a near-zero-height
                 geometric bounding box, so a percentage-based region clips the
                 blur/glow almost entirely. Padding is sized to the panel's own
                 canvas instead of a fixed 2500x2500, so it still shrinks for
                 small/medium circuits. -->
            <filter id="trace-3d-active-${panelId}" filterUnits="userSpaceOnUse" x="${-50}" y="${-50}" width="${width + 100}" height="${height + 100}">
                <feDropShadow dx="1" dy="1.5" stdDeviation="1" flood-color="#000" flood-opacity="0.6" result="shadow"/>
                <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="blur"/>
                <feSpecularLighting in="blur" surfaceScale="2" specularConstant="1.2" specularExponent="20" lighting-color="#a5d6a7" result="specOut">
                    <fePointLight x="-500" y="-500" z="300"/>
                </feSpecularLighting>
                <feComposite in="specOut" in2="SourceAlpha" operator="in" result="specOut"/>
                <feComposite in="SourceGraphic" in2="specOut" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="litPaint"/>
                <!-- Green Glow halo -->
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="glow"/>
                <feMerge>
                    <feMergeNode in="shadow"/>
                    <feMergeNode in="glow"/>
                    <feMergeNode in="litPaint"/>
                </feMerge>
            </filter>

            <!-- Inactive Trace 3D (Light Green Trace under solder mask) -->
            <filter id="trace-3d-inactive-${panelId}" filterUnits="userSpaceOnUse" x="${-50}" y="${-50}" width="${width + 100}" height="${height + 100}">
                <feDropShadow dx="1" dy="1.5" stdDeviation="1" flood-color="#000" flood-opacity="0.5"/>
                <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="blur"/>
                <feSpecularLighting in="blur" surfaceScale="1.5" specularConstant="0.8" specularExponent="15" lighting-color="#ffffff" result="specOut">
                    <fePointLight x="-500" y="-500" z="300"/>
                </feSpecularLighting>
                <feComposite in="specOut" in2="SourceAlpha" operator="in" result="specOut"/>
                <feComposite in="SourceGraphic" in2="specOut" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>
            </filter>

            <!-- LED ON glow -->
            <filter id="led-glow-${panelId}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="12" result="blur"/>
                <feComposite in="SourceGraphic" in2="blur" operator="over"/>
            </filter>
            <filter id="led-glow-small-${panelId}" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="2" result="blur"/>
                <feComposite in="SourceGraphic" in2="blur" operator="over"/>
            </filter>

            <radialGradient id="led-on-${panelId}" cx="35%" cy="30%" r="65%" fx="30%" fy="25%">
                <stop offset="0%" stop-color="#ffffff"/>
                <stop offset="15%" stop-color="#ffdd44"/>
                <stop offset="45%" stop-color="#ff4400"/>
                <stop offset="100%" stop-color="#991100"/>
            </radialGradient>

            <radialGradient id="led-off-${panelId}" cx="35%" cy="30%" r="65%" fx="30%" fy="25%">
                <stop offset="0%" stop-color="#662222"/>
                <stop offset="60%" stop-color="#220000"/>
                <stop offset="100%" stop-color="#050000"/>
            </radialGradient>
            
            <!-- Silkscreen Emboss: no shadow, just a clean label -->
            <filter id="silkscreen-${panelId}">
                <feComposite in="SourceGraphic" in2="SourceGraphic" operator="over"/>
            </filter>
        </defs>

        <!-- PCB shadow: plain dark rect offset behind the board (no filter, works on all GPUs) -->
        <rect x="${10}" y="${14}" width="${width}" height="${height}" fill="#030d05" rx="14" opacity="0.65"/>
        <!-- PCB Board -->
        <rect x="0" y="0" width="${width}" height="${height}" fill="#246b3e" rx="12" />
        <rect x="0" y="0" width="${width}" height="${height}" fill="url(#pcb-holes-${panelId})" rx="12" opacity="0.4"/>
        <!-- PCB mounting holes at corners (gold ring, dark hole) -->
        <circle cx="16" cy="16" r="7" fill="url(#metal-pad-${panelId})"/>
        <circle cx="16" cy="16" r="3.5" fill="#051005"/>
        <circle cx="${width-16}" cy="16" r="7" fill="url(#metal-pad-${panelId})"/>
        <circle cx="${width-16}" cy="16" r="3.5" fill="#051005"/>
        <circle cx="16" cy="${height-16}" r="7" fill="url(#metal-pad-${panelId})"/>
        <circle cx="16" cy="${height-16}" r="3.5" fill="#051005"/>
        <circle cx="${width-16}" cy="${height-16}" r="7" fill="url(#metal-pad-${panelId})"/>
        <circle cx="${width-16}" cy="${height-16}" r="3.5" fill="#051005"/>
    `;
    
    // --- DRAW COPPER TRACES ---
    // Each node gets a stable index (its position in posMap's iteration order,
    // which is deterministic for a given tree) so toggleSimInput can look these
    // paths back up by id later without re-walking/re-stringifying the tree.
    {
        let traceIdx = 0;
        for (const [node, pos] of posMap.entries()) {
            const myIdx = traceIdx++;
            if (node.isGate && node.children) {
                const tx = pos.x + dx;
                const ty = pos.y + dy;
                const numInputs = node.children.length;
                const portSpacing = 18;
                const startPortY = ty - ((numInputs - 1) * portSpacing) / 2;

                for (let i = 0; i < numInputs; i++) {
                    const child = node.children[i];
                    const childPos = posMap.get(child);
                    const cX = childPos.x + dx;
                    const cY = childPos.y + dy;

                    let sourceX = child.isGate ? getGateOutputPinRange(child.type, cX, child.children ? child.children.length : 2).endX : cX;
                    const targetY = startPortY + i * portSpacing;
                    // Add a tiny 0.5px vertical offset to avoid 0-height SVG bounding box clipping by filters
                    const adjustedTargetY = (cY === targetY) ? targetY + 0.5 : targetY;
                    let midX = Math.max(sourceX + 12, tx - 42);
                    if (numInputs === 4 && (i === 1 || i === 2)) {
                        midX = Math.max(sourceX + 5, tx - 58);
                    }
                    const endX = tx - 35;

                    const childState = evaluateSimLogic(child);
                    const traceId = `trace-${panelId}-${myIdx}-${i}`;

                    if (childState) {
                        svgContent += `<path id="${traceId}" d="M ${sourceX} ${cY} L ${midX} ${cY} L ${midX} ${adjustedTargetY} L ${endX} ${adjustedTargetY}" fill="none" stroke="#4ade80" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trace-3d-active-${panelId})"/>`;
                    } else {
                        svgContent += `<path id="${traceId}" d="M ${sourceX} ${cY} L ${midX} ${cY} L ${midX} ${adjustedTargetY} L ${endX} ${adjustedTargetY}" fill="none" stroke="#154c27" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trace-3d-inactive-${panelId})"/>`;
                    }
                }
            }
        }
    }

        // --- OUTPUT TRACE ---
    const rootPos = posMap.get(root);
    const rootX = rootPos.x + dx;
    const rootY = rootPos.y + dy;
    const finalState = evaluateSimLogic(root);
    const rootOutX = root.isGate ? getGateOutputPinRange(root.type, rootX, root.children ? root.children.length : 2).endX : rootX;
    const extraOutLen = root.isGate ? 0 : 80;
    const ledX = rootOutX + 40 + extraOutLen; 
    const ledY = rootY;
    
    // OUTPUT TRACE: runs straight horizontally to the left edge of the LED dome
    const traceEndX = ledX - 18;
    const adjustedTraceEndY = (rootY === rootY) ? rootY + 0.5 : rootY; // prevent 0-height filter clip
    
    if (finalState) {
        svgContent += `<path id="output-trace-${panelId}" d="M ${rootOutX} ${rootY} L ${traceEndX} ${adjustedTraceEndY}" fill="none" stroke="#4ade80" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trace-3d-active-${panelId})"/>`;
    } else {
        svgContent += `<path id="output-trace-${panelId}" d="M ${rootOutX} ${rootY} L ${traceEndX} ${adjustedTraceEndY}" fill="none" stroke="#154c27" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trace-3d-inactive-${panelId})"/>`;
    }
    
    // --- DRAW SILKSCREEN OUTLINES & SOLDER PADS ---
    for (const [node, pos] of posMap.entries()) {
        const x = pos.x + dx;
        const y = pos.y + dy;
        
        if (!node.isGate) {
            const isConst = node.value === '0' || node.value === '1';
            if (isConst) {
                svgContent += `<circle cx="${x}" cy="${y}" r="18" fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.6" filter="url(#silkscreen-${panelId})"/>`;
            } else {
                svgContent += `<rect x="${x-24}" y="${y-24}" width="48" height="48" rx="7" fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.6" filter="url(#silkscreen-${panelId})"/>`;
            }
        } else {
            svgContent += getSimGateSilkscreen(node.type, x, y, panelId, node.children ? node.children.length : 2);
        }
    }

    // --- DRAW COMPONENTS (ICs & Buttons) ---
    // componentIdx walks posMap in the same order/index as the copper-traces
    // loop above, so a given node gets the same index in both — toggleSimInput
    // relies on that to find the right elements by id.
    let componentIdx = 0;
    for (const [node, pos] of posMap.entries()) {
        const myIdx = componentIdx++;
        const x = pos.x + dx;
        const y = pos.y + dy;
        const state = evaluateSimLogic(node);
        
        if (!node.isGate) {
            const isConst = node.value === '0' || node.value === '1';
            
            if (isConst) {
                // VCC / GND Terminal Posts
                const label = state ? 'VCC' : 'GND';
                const color = state ? '#20c060' : '#c02020';
                svgContent += `
                    <circle cx="${x}" cy="${y}" r="16" fill="url(#metal-pin-${panelId})" filter="url(#plastic-3d-${panelId})"/>
                    <circle cx="${x}" cy="${y}" r="10" fill="#111" filter="url(#plastic-3d-${panelId})"/>
                    <text x="${x}" y="${y+32}" font-family="JetBrains Mono,monospace" font-size="12" font-weight="bold" fill="${color}" text-anchor="middle" stroke="#1A4E2C" stroke-width="3" paint-order="stroke fill">${label}</text>
                `;
            } else {
                const varName = node.value;
                // Unpressed: cap floats above center. Pressed: cap sits at center.
                const capCY = state ? y : y - 4;
                const statusDot = `<circle id="toggle-dot-${panelId}-${myIdx}" cx="${x+13}" cy="${y-13}" r="3.5" fill="${state ? '#30d158' : '#ff453a'}" filter="url(#led-glow-small-${panelId})"/>`;
                svgContent += `
                    <g class="sim-toggle" data-var="${varName}" style="cursor:pointer;">
                        <!-- Solder legs -->
                        <rect x="${x-24}" y="${y-5}" width="5" height="10" rx="1.5" fill="url(#metal-pin-${panelId})" opacity="0.85"/>
                        <rect x="${x+19}" y="${y-5}" width="5" height="10" rx="1.5" fill="url(#metal-pin-${panelId})" opacity="0.85"/>
                        <!-- Housing (fixed) -->
                        <rect x="${x-22}" y="${y-22}" width="44" height="44" rx="6" fill="#151515" filter="url(#plastic-3d-${panelId})"/>
                        <!-- Cap circle -->
                        <circle id="toggle-cap-${panelId}-${myIdx}" cx="${x}" cy="${capCY}" r="13" fill="#333" filter="url(#btn-cap-3d-${panelId})"/>
                        <!-- Status dot -->
                        ${statusDot}
                        <!-- Label -->
                        <text x="${x-35}" y="${y}" font-family="Outfit,sans-serif" font-size="18" font-weight="900" fill="#fff" text-anchor="end" dominant-baseline="central" stroke="#1A4E2C" stroke-width="3" paint-order="stroke fill">${varName}</text>
                    </g>
                `;
            }
        } else {
            // Logic Gate IC
            const numInputs = node.children ? node.children.length : 0;
            const portSpacing = 18;
            const startPortY = y - ((numInputs - 1) * portSpacing) / 2;
            
            // Draw input pins
            for (let i = 0; i < numInputs; i++) {
                const py = startPortY + i * portSpacing;
                const pinStartX = x - 35;
                const pinEndX = x - 15;
                svgContent += `<rect x="${pinStartX}" y="${py - 2}" width="${pinEndX - pinStartX}" height="4" fill="url(#metal-pin-${panelId})" filter="url(#trace-3d-inactive-${panelId})"/>`;
            }
            // Draw output pin
            const pinRange = getGateOutputPinRange(node.type, x, numInputs);
            svgContent += `<rect x="${pinRange.startX}" y="${y - 2}" width="${pinRange.endX - pinRange.startX}" height="4" fill="url(#metal-pin-${panelId})" filter="url(#trace-3d-inactive-${panelId})"/>`;
            
            // Gate body
            svgContent += getSimGateShape(node.type, x, y, panelId, numInputs);
            
            // Silkscreen type label
            svgContent += `<text x="${x}" y="${y - 28}" font-family="JetBrains Mono,monospace" font-size="12" font-weight="bold" fill="#ddd" text-anchor="middle" stroke="#1A4E2C" stroke-width="3" paint-order="stroke fill">${node.type}</text>`;
            
            // Active status LED on the IC itself (Centered on the gate body)
            const dotX = x - 5;
            if (state) {
                svgContent += `<circle id="gate-dot-${panelId}-${myIdx}" cx="${dotX}" cy="${y}" r="2.5" fill="#60ff60" filter="url(#led-glow-small-${panelId})"/>`;
            } else {
                svgContent += `<circle id="gate-dot-${panelId}-${myIdx}" cx="${dotX}" cy="${y}" r="2.5" fill="#113311"/>`;
            }
        }
    }
    
    
    // --- 3D OUTPUT LED ---
    // Silkscreen outline for LED
    svgContent += `<circle cx="${ledX}" cy="${ledY}" r="21" fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.6" filter="url(#silkscreen-${panelId})"/>`;

    // LED legs removed — LED is a through-hole component, no legs shown
    
    // LED Base ring (plastic collar)
    svgContent += `<ellipse id="led-base-${panelId}" cx="${ledX}" cy="${ledY}" rx="18" ry="18" fill="${finalState ? '#882200' : '#220000'}" filter="url(#plastic-3d-${panelId})"/>`;
    
    // LED Dome
    svgContent += `<circle id="led-dome-${panelId}" cx="${ledX}" cy="${ledY}" r="15" fill="${finalState ? 'url(#led-on-' + panelId + ')' : 'url(#led-off-' + panelId + ')'}" filter="url(#btn-cap-3d-${panelId})"/>`;
    
    // Ambient glow (yellow-orange, matches real LED colour). Always present
    // (opacity toggled) rather than conditionally appended, so a state flip
    // is a single attribute write instead of an add/remove.
    svgContent += `<circle id="led-glow-circle-${panelId}" cx="${ledX}" cy="${ledY}" r="45" fill="#ffe000" opacity="${finalState ? '0.35' : '0'}" filter="url(#led-glow-${panelId})" style="pointer-events: none;"/>`;
    
    // Silkscreen Label
    svgContent += `<text x="${ledX}" y="${ledY - 26}" font-family="Outfit,sans-serif" font-size="14" font-weight="900" fill="#ffffff" text-anchor="middle" stroke="#1A4E2C" stroke-width="3" paint-order="stroke fill">OUTPUT</text>`;
    
    // Cache the layout (node positions + offsets) this render computed, keyed
    // by panelId, so toggleSimInput can recolor the existing DOM in place on
    // the next click instead of recomputing depth/positions and re-stringifying
    // the whole SVG. Safe to key by insertion-order index because posMap is a
    // Map — iterating it again later yields nodes in this exact same order.
    _simLayoutCache[panelId] = { root, posMap, dx, dy };

    // Total SVG canvas must include the shadow overhang (10px right, 14px down)
    const svgW = width + 10;
    const svgH = height + 14;
    return `
        <div class="zoom-content-wrapper" style="position: absolute; width: ${svgW}px; height: ${svgH}px; transform-origin: 0 0; will-change: transform;">
            <svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" style="position: absolute; left: 0; top: 0;">
                ${svgContent}
            </svg>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// Drag-to-Scroll Logic for Solutions Carousel
// -----------------------------------------------------------------------------
if (elements.solutionsCarousel) {
    let isDown = false;
    let startX;
    let scrollLeft;

    elements.solutionsCarousel.addEventListener('mousedown', (e) => {
        isDown = true;
        elements.solutionsCarousel.style.cursor = 'grabbing';
        startX = e.pageX - elements.solutionsCarousel.offsetLeft;
        scrollLeft = elements.solutionsCarousel.scrollLeft;
    });

    elements.solutionsCarousel.addEventListener('mouseleave', () => {
        isDown = false;
        elements.solutionsCarousel.style.cursor = 'grab';
    });

    elements.solutionsCarousel.addEventListener('mouseup', () => {
        isDown = false;
        elements.solutionsCarousel.style.cursor = 'grab';
    });

    elements.solutionsCarousel.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - elements.solutionsCarousel.offsetLeft;
        const walk = (x - startX) * 2; // Scroll-fast modifier
        elements.solutionsCarousel.scrollLeft = scrollLeft - walk;
    });
}

// Blur search input when interacting with canvas (K-map/Simulation) to allow syncLoop updates
if (elements.canvas) {
    ['mousedown', 'touchstart'].forEach(evt => {
        elements.canvas.addEventListener(evt, () => {
            if (document.activeElement === elements.input) {
                elements.input.blur();
            }
        }, true);
    });
}
let lastKMapData = null;

// KMap Colors for loops
const LOOP_COLORS = [
    '#007AFF', // Blue
    '#34C759', // Green
    '#FF3B30', // Red
    '#FF9500', // Orange
    '#AF52DE', // Purple
    '#5856D6', // Indigo
    '#FF2D55', // Pink
    '#5AC8FA', // Teal
    '#FFCC00', // Yellow
    '#00C7BE', // Cyan
    '#A2845E', // Brown
    '#FF6B22', // Coral
    '#E586C6', // Mauve
    '#8D99AE', // Slate
    '#4B8A08', // Dark Green
    '#B53A15'  // Rust
];

// Cell size (px) used only by the infinite Wrap view. Kept smaller than the
// Normal view's 80px cells so several repeated tiles are visible at once
// instead of just one screen's worth.
const WRAP_CELL_SIZE = 44;

// Currently-selected implicant term (a binary/don't-care pattern string like
// "1-0-"), clicked from the analysis board's Minimal Expression or Essential
// Prime Implicants sections. When set, every K-map view (normal, wrap, multi-
// plane, 3D) draws only that one group instead of the whole solution — the
// group keeps the exact color it already had (LOOP_COLORS[idx-in-solution]),
// nothing is recolored, only filtered. null means "show everything" (default).
let _selectedImplicantTerm = null;

/** Toggle selection of an implicant's K-map group from the analysis board. */
function selectImplicantGroup(term) {
    _selectedImplicantTerm = (_selectedImplicantTerm === term) ? null : term;
    renderHTMLKMap();
}
window.selectImplicantGroup = selectImplicantGroup;

function renderHTMLKMap() {
    if (!wasmReady) return;

    const jsonStr = queryWasmString('mantiq_getKMapJSON');
    const container = document.getElementById('kmap-grid-container');
    const svgOverlay = document.getElementById('kmap-svg-overlay');
    const implicantsList = document.getElementById('kmap-implicants-list');
    
    if (!jsonStr) {
        lastKMapData = null;
        if (container) container.innerHTML = '<div class="empty-msg">No expression processed yet</div>';
        if (svgOverlay) svgOverlay.innerHTML = '';
        if (implicantsList) implicantsList.innerHTML = '';
        return;
    }
    
    try {
        lastKMapData = JSON.parse(jsonStr);
    } catch (e) {
        console.error("Failed to parse KMap JSON:", e);
        return;
    }

    const { variables, minterms, dontCares, solutions, solutionsPOS } = lastKMapData;
    const numVars = variables.length;

    const sopPosEl = document.getElementById('sop-pos-pill');
    const isSOP = sopPosEl ? sopPosEl.getAttribute('data-state') === 'sop' : true;
    const activeSolutions = isSOP ? solutions : solutionsPOS;
    let selectedIdx = typeof selectedSolutionIndex !== 'undefined' ? selectedSolutionIndex : 0;
    if (selectedIdx >= activeSolutions.length) selectedIdx = 0;
    
    const activeSolution = activeSolutions.length > 0 ? activeSolutions[selectedIdx] : [];

    // A selection from a previous expression (or the other SOP/POS side) may
    // no longer correspond to anything real — drop it rather than silently
    // filtering every group out of every view.
    if (_selectedImplicantTerm !== null) {
        const activeEPIsForValidity = isSOP ? lastKMapData.essentialPrimeImplicants : lastKMapData.essentialPrimeImplicantsPOS;
        const stillValid = activeSolution.includes(_selectedImplicantTerm) ||
            (activeEPIsForValidity && activeEPIsForValidity.includes(_selectedImplicantTerm));
        if (!stillValid) _selectedImplicantTerm = null;
    }

    // Setup K-Map view toggle button state
    const kmapViewToggleBtn = document.getElementById('kmap-view-toggle-btn');
    if (kmapViewToggleBtn) {
        if (numVars <= 4) {
            if (kmapViewMode === '3d') kmapViewMode = 'wrap';
            if (kmapViewMode !== 'normal' && kmapViewMode !== 'wrap') kmapViewMode = 'normal';
            
            kmapViewToggleBtn.title = kmapViewMode === 'normal' ? 'Switch to Wrap View' : 'Switch to Normal View';
            kmapViewToggleBtn.innerHTML = kmapViewMode === 'normal' 
                ? '<span style="font-family: \'Outfit\', sans-serif; font-size: 11px; font-weight: 700;">WRP</span>'
                : '<span style="font-family: \'Outfit\', sans-serif; font-size: 11px; font-weight: 700;">2D</span>';
            kmapViewToggleBtn.classList.toggle('active', kmapViewMode === 'wrap');
        } else {
            if (kmapViewMode === 'wrap') kmapViewMode = '3d';
            if (kmapViewMode !== 'normal' && kmapViewMode !== '3d') kmapViewMode = 'normal';

            kmapViewToggleBtn.title = kmapViewMode === 'normal' ? 'Switch to 3D View' : 'Switch to 2D View';
            kmapViewToggleBtn.innerHTML = kmapViewMode === 'normal'
                ? '<span style="font-family: \'Outfit\', sans-serif; font-size: 11px; font-weight: 700;">3D</span>'
                : '<span style="font-family: \'Outfit\', sans-serif; font-size: 11px; font-weight: 700;">2D</span>';
            kmapViewToggleBtn.classList.toggle('active', kmapViewMode === '3d');
        }
    }

    renderKMapAnalysis(activeSolution, isSOP, variables);

    if (numVars <= 4) {
        if (kmapViewMode === 'wrap') {
            renderWrapKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP);
        } else {
            render2DKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP, true);
        }
    } else {
        if (kmapViewMode === '3d') {
            render3DKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP);
        } else {
            renderMultiple2DKMaps(numVars, variables, minterms, dontCares, activeSolution, isSOP);
        }
    }
}

function getGrayCodeStr(numBits) {
    if (numBits === 1) return ["0", "1"];
    if (numBits === 2) return ["00", "01", "11", "10"];
    return [];
}

function render2DKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP, showLoops = false) {
    const container = document.getElementById('kmap-grid-container');
    const svgOverlay = document.getElementById('kmap-svg-overlay');
    const wrapper3d = document.getElementById('kmap-3d-container');
    const wrapContainer = document.getElementById('kmap-wrap-container');
    
    container.style.display = 'block';
    container.style.flexWrap = 'unset';
    container.style.gap = '0';
    container.style.justifyContent = 'unset';
    container.style.alignItems = 'unset';
    container.style.gridTemplateColumns = 'unset';
    container.classList.remove('kmap-small');
    container.style.transform = 'none'; // reset scale
    
    svgOverlay.style.display = 'block';
    if(wrapper3d) wrapper3d.style.display = 'none';
    if(wrapContainer) wrapContainer.style.display = 'none';

    let rowsBits = 1;
    let colsBits = 1;
    if (numVars === 3) { rowsBits = 1; colsBits = 2; }
    if (numVars === 4) { rowsBits = 2; colsBits = 2; }
    if (numVars === 2) { rowsBits = 1; colsBits = 1; }

    const rowVars = variables.slice(0, rowsBits);
    const colVars = variables.slice(rowsBits);
    
    const rowGray = getGrayCodeStr(rowsBits);
    const colGray = getGrayCodeStr(colsBits);
    
    let html = '<table class="kmap-table">';
    html += `<tr><th class="kmap-corner" style="position: relative; padding: 0; min-width: 40px; height: 40px;"><svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="100%" stroke="var(--border)" stroke-width="1.5" /></svg><div class="kmap-corner-col">${colVars.join('')}</div><div class="kmap-corner-row">${rowVars.join('')}</div></th>`;
    for (let c of colGray) { html += `<th style="height: 40px; vertical-align: bottom; padding-bottom: 2px;">${c}</th>`; }
    html += '</tr>';

    for (let r = 0; r < rowGray.length; r++) {
        html += `<tr><th style="width: 40px; text-align: right; padding-right: 4px;">${rowGray[r]}</th>`;
        for (let c = 0; c < colGray.length; c++) {
            const binaryStr = rowGray[r] + colGray[c];
            const minterm = parseInt(binaryStr, 2);
            let val = '0';
            if (minterms.includes(minterm)) val = '1';
            if (dontCares.includes(minterm)) val = 'X';
            
            html += `<td id="kmap-cell-${minterm}" class="kmap-cell val-${val}" data-minterm="${minterm}" onclick="handleKMapCellClick(${minterm})">`;
            html += `<div class="kmap-minterm-label">${minterm}</div>`;
            html += `${val}</td>`;
        }
        html += '</tr>';
    }
    html += '</table>';

    container.innerHTML = html;
    
    // Synchronous layout and scale
    const wrapper = document.getElementById('kmap-visual-wrapper');
    const rect = container.getBoundingClientRect();
    const availW = wrapper.clientWidth - 40;
    const availH = wrapper.clientHeight - 40;
    
    // Scale UP or DOWN to fit perfectly
    const isMobileKMap = window.innerWidth <= 900;
    let scale = Math.min(availW / rect.width, availH / rect.height);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    if (isMobileKMap) {
        scale = Math.min(scale, 1); // keep the K-Map at its default size on mobile, never enlarge it
    } else if (scale > 2.2) {
        scale = 2.2; // Cap max scale so it doesn't get ridiculously huge
    }

    // The 4x4 K-map's cell size (at whatever scale it takes to fit this same
    // available area) is the reference "perfect" size. Smaller maps (2x2,
    // 2x4) have more free space to grow into, but should never end up with
    // bigger cells than that reference - so clamp their scale to whatever a
    // 4x4 map would use here, rather than filling all the extra space.
    const HEADER_PX = 50;
    const CELL_PX = 80;
    const refGridPx = HEADER_PX + 4 * CELL_PX;
    let maxScale4x4 = Math.min(availW / refGridPx, availH / refGridPx);
    if (!isFinite(maxScale4x4) || maxScale4x4 <= 0) maxScale4x4 = scale;
    if (maxScale4x4 > 2.2) maxScale4x4 = 2.2;
    if (numVars < 4) scale = Math.min(scale, maxScale4x4);
    
    container.style.transform = `scale(${scale})`;
    container.style.transformOrigin = 'center center';
    
    // SVG sizing and drawing must wait 1 tick for the DOM to reflect transform.
    // Clearing happens here too (not before the rAF) so the old loops and the
    // new loops swap in the same paint - clearing earlier left a one-frame
    // gap where the overlay was empty, which read as every group "blinking"
    // on each re-render (e.g. every time a cell is clicked).
    requestAnimationFrame(() => {
        svgOverlay.setAttribute('width', svgOverlay.parentElement.clientWidth);
        svgOverlay.setAttribute('height', svgOverlay.parentElement.clientHeight);
        svgOverlay.innerHTML = '';
        if (showLoops && activeSolution && activeSolution.length > 0) {
            drawSVGLoops(activeSolution, numVars, rowsBits, colsBits, rowGray, colGray, false, '', scale);
        }
    });
}

function handleKMapCellClick(minterm) {
    // wrapDragState.hasMoved is only meaningful for a click that originated
    // in the Wrap view (it suppresses the native click that follows a
    // drag-to-pan gesture there). It's only ever reset back to false at the
    // START of the *next* Wrap-view pointer-down — never when the user
    // leaves Wrap view. So a pan/drag in Wrap view left it stuck at `true`,
    // and every subsequent tap in the 2D or 3D view (which share this same
    // handler) was silently swallowed by this check, since nothing in
    // those views ever cleared it. Scoping the check to kmapViewMode ===
    // 'wrap' keeps the intended guard there without it leaking into the
    // other views.
    if (kmapViewMode === 'wrap' && typeof wrapDragState !== 'undefined' && wrapDragState.hasMoved) {
        return;
    }
    if (!lastKMapData) return;
    
    let { variables, minterms, dontCares } = lastKMapData;
    let newMinterms = [...minterms];
    let newDontCares = [...dontCares];

    if (newDontCares.includes(minterm)) {
        newDontCares = newDontCares.filter(m => m !== minterm);
    } else if (newMinterms.includes(minterm)) {
        newMinterms = newMinterms.filter(m => m !== minterm);
        newDontCares.push(minterm);
    } else {
        newMinterms.push(minterm);
    }

    newMinterms.sort((a, b) => a - b);
    newDontCares.sort((a, b) => a - b);

    const parts = [];
    if (newMinterms.length > 0) parts.push(`m(${newMinterms.join(',')})`);
    if (newDontCares.length > 0) parts.push(`d(${newDontCares.join(',')})`);
    const newExpr = `${variables.join(',')}: ${parts.join(' ')}`;
    
    const inputEl = document.getElementById('expression-input');
    inputEl.value = newExpr;
    
    if (typeof selectedSolutionIndex !== 'undefined') selectedSolutionIndex = 0;
    
    // Dispatch a native input event to trigger the main reactive pipeline
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// Same idea as computeAntiOverlapShrink, but operating on integer grid
// coordinates (row/col index ranges) instead of measured pixel rects. The
// normal 2D K-map is drawn inside a CSS-scaled container (transform:
// scale(...)), so two pieces' pixel edges - even when they're conceptually
// touching the same grid line - can end up a fraction of a pixel apart after
// scaling/rounding, which made the pixel-based epsilon check miss real
// adjacencies. Grid coordinates have no such rounding, so adjacency here is
// exact.
function computeAntiOverlapShrinkGrid(boxes) {
    const n = boxes.length;
    // Per-box, per-edge extra inset (not a single scalar) - a box should
    // only pull back on the specific side(s) that actually run into another
    // group's border, not shrink uniformly on all four sides just because
    // *some* edge somewhere had a conflict.
    const extra = boxes.map(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
    // Two boxes merely touching (adjacent, different boundary lines) never
    // need help here - each already measures its padding inward from its
    // own edge, so their drawn borders end up naturally separated by 2x the
    // base pad with no extra work. The only real problem case is two boxes
    // whose edges sit on the EXACT SAME boundary line while their interiors
    // overlap (e.g. both start at row 0) - both would then measure the same
    // base pad from the same line and land on identical pixels. For that
    // case only ONE of the two boxes should pull back further, not both -
    // bumping both by the same amount just moves them inward together and
    // leaves them exactly as coincident as before.
    const STEP = 6;
    const CAP = 18;
    const bump = (side, edge) => { side[edge] = Math.min(side[edge] + STEP, CAP); };

    for (let i = 0; i < n; i++) {
        if (!boxes[i]) continue;
        for (let j = i + 1; j < n; j++) {
            if (!boxes[j]) continue;
            const a = boxes[i], b = boxes[j];
            // Different fragments of the SAME wrapped group (e.g. the up to
            // four corner pieces of a four-corners loop) are one logical
            // loop, not two groups touching each other - never push them
            // apart from one another.
            if (a.idx === b.idx) continue;

            const rowOverlap = Math.min(a.rowHi, b.rowHi) - Math.max(a.rowLo, b.rowLo) + 1;
            const colOverlap = Math.min(a.colHi, b.colHi) - Math.max(a.colLo, b.colLo) + 1;

            // --- Horizontal boundaries (top/bottom): only matters while the
            // two boxes' column ranges actually overlap - push only the
            // later box (b) in, so its edge lands visibly inside a's ---
            if (colOverlap > 0) {
                if (a.rowLo === b.rowLo) bump(extra[j], 'top');
                if (a.rowHi === b.rowHi) bump(extra[j], 'bottom');
            }

            // --- Vertical boundaries (left/right): only matters while the
            // two boxes' row ranges actually overlap ---
            if (rowOverlap > 0) {
                if (a.colLo === b.colLo) bump(extra[j], 'left');
                if (a.colHi === b.colHi) bump(extra[j], 'right');
            }
        }
    }
    return extra;
}

// Given a list of raw (un-padded) bounding boxes {minX,minY,maxX,maxY} (or
// null for "no box"), figures out extra inset each box needs so that any
// pair of boxes sharing a boundary line (even for just one cell's worth of
// overlap) end up with visibly separated borders instead of drawing right
// on top of each other. Boxes can still touch/cross at a point — only a
// shared, overlapping *edge* gets pushed apart. Returns an array of extra
// px to add (on top of the normal pad) per box, indexed the same way.
function computeAntiOverlapShrink(rects) {
    const n = rects.length;
    const extra = new Array(n).fill(0);
    const eps = 2; // px tolerance for "the same line" (float/rounding slack)

    for (let i = 0; i < n; i++) {
        if (!rects[i]) continue;
        for (let j = i + 1; j < n; j++) {
            if (!rects[j]) continue;
            const a = rects[i], b = rects[j];

            const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
            const yOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);

            const sharesHorizEdge = xOverlap > eps && (
                Math.abs(a.minY - b.minY) < eps || Math.abs(a.minY - b.maxY) < eps ||
                Math.abs(a.maxY - b.minY) < eps || Math.abs(a.maxY - b.maxY) < eps
            );
            const sharesVertEdge = yOverlap > eps && (
                Math.abs(a.minX - b.minX) < eps || Math.abs(a.minX - b.maxX) < eps ||
                Math.abs(a.maxX - b.minX) < eps || Math.abs(a.maxX - b.maxX) < eps
            );

            if (sharesHorizEdge || sharesVertEdge) {
                // Shrink the later box a bit more so the shared line separates.
                extra[j] = Math.min(extra[j] + 4, 14);
            }
        }
    }
    return extra;
}

// Given a boolean membership array over a cyclic axis (row or column indices
// in Gray-code order, where index 0 and the last index are the two cells
// physically adjacent across the map's edge), splits it into 1+ linear
// (non-wrapping) runs. Because valid K-map groups are always contiguous once
// wraparound is accounted for, membership is either: (a) the whole axis,
// (b) a single contiguous run touching neither end specially, or (c) exactly
// two runs — one touching index 0, one touching the last index — which
// together are really one run that wraps across the array boundary (e.g. a
// four-corners group). Each returned run is tagged with which of its edges,
// if any, is the "wrap" edge — the edge that faces where the group actually
// continues on the opposite side of the map, rather than a true boundary.
function computeAxisRuns(present) {
    const L = present.length;
    if (present.every(p => p)) {
        return [{ lo: 0, hi: L - 1, wrapLow: false, wrapHigh: false }];
    }
    const runs = [];
    let i = 0;
    while (i < L) {
        if (!present[i]) { i++; continue; }
        let j = i;
        while (j + 1 < L && present[j + 1]) j++;
        runs.push({ lo: i, hi: j });
        i = j + 1;
    }
    if (runs.length <= 1) {
        return runs.map(r => ({ lo: r.lo, hi: r.hi, wrapLow: false, wrapHigh: false }));
    }
    // Multiple runs on a cyclic axis: the run touching index 0 wraps on its
    // low side, the run touching the last index wraps on its high side.
    return runs.map(r => ({
        lo: r.lo,
        hi: r.hi,
        wrapLow: r.lo === 0,
        wrapHigh: r.hi === L - 1
    }));
}

// Draws one rectangular piece of a group's outline at (x,y,w,h). Sides
// flagged in wrapSides are the ones where the group actually continues on
// the opposite edge of the map (rather than truly ending there) — those
// sides are simply left open (no line drawn), so the group reads as
// disappearing into that wall and continuing on the other side, instead of
// falsely implying a boundary there.
function drawLoopPieceSVG(svg, x, y, w, h, color, wrapSides, scale) {
    const r = Math.min(12 * scale, w / 2, h / 2);
    const strokeWidth = Math.max(1, 3 * scale);
    const x2 = x + w, y2 = y + h;

    // A corner is only rounded when both of the sides that meet there are
    // real boundaries. If either adjacent side is a wrap edge, that corner
    // is left sharp/flush instead — it isn't a real corner, it's a straight
    // cut where the shape keeps going through the wall.
    const roundTL = !(wrapSides.top || wrapSides.left);
    const roundTR = !(wrapSides.top || wrapSides.right);
    const roundBR = !(wrapSides.bottom || wrapSides.right);
    const roundBL = !(wrapSides.bottom || wrapSides.left);

    const rTL = roundTL ? r : 0;
    const rTR = roundTR ? r : 0;
    const rBR = roundBR ? r : 0;
    const rBL = roundBL ? r : 0;

    // Fill: a single closed outline that matches the same "chopped pill"
    // shape — rounded on real corners, flat/cropped on wrap corners.
    const fillPath =
        `M ${x + rTL} ${y} ` +
        `L ${x2 - rTR} ${y} ` +
        (rTR > 0 ? `A ${rTR} ${rTR} 0 0 1 ${x2} ${y + rTR} ` : `L ${x2} ${y} `) +
        `L ${x2} ${y2 - rBR} ` +
        (rBR > 0 ? `A ${rBR} ${rBR} 0 0 1 ${x2 - rBR} ${y2} ` : `L ${x2} ${y2} `) +
        `L ${x + rBL} ${y2} ` +
        (rBL > 0 ? `A ${rBL} ${rBL} 0 0 1 ${x} ${y2 - rBL} ` : `L ${x} ${y2} `) +
        `L ${x} ${y + rTL} ` +
        (rTL > 0 ? `A ${rTL} ${rTL} 0 0 1 ${x + rTL} ${y} ` : `L ${x} ${y} `) +
        `Z`;

    const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
    fill.setAttribute("d", fillPath);
    fill.setAttribute("fill", color);
    fill.setAttribute("fill-opacity", "0.2");
    svg.appendChild(fill);

    // Stroke: the exact same outline, except the wrap side(s) are left open
    // (no line, so the box reads as disappearing into the wall) and only
    // the real corners get an arc — matching the rounded style of normal
    // groups everywhere the box isn't touching a wall.
    const segs = [
        !wrapSides.top    && `M ${x + rTL} ${y} L ${x2 - rTR} ${y}`,
        roundTR           && `M ${x2 - rTR} ${y} A ${rTR} ${rTR} 0 0 1 ${x2} ${y + rTR}`,
        !wrapSides.right  && `M ${x2} ${y + rTR} L ${x2} ${y2 - rBR}`,
        roundBR           && `M ${x2} ${y2 - rBR} A ${rBR} ${rBR} 0 0 1 ${x2 - rBR} ${y2}`,
        !wrapSides.bottom && `M ${x2 - rBR} ${y2} L ${x + rBL} ${y2}`,
        roundBL           && `M ${x + rBL} ${y2} A ${rBL} ${rBL} 0 0 1 ${x} ${y2 - rBL}`,
        !wrapSides.left   && `M ${x} ${y2 - rBL} L ${x} ${y + rTL}`,
        roundTL           && `M ${x} ${y + rTL} A ${rTL} ${rTL} 0 0 1 ${x + rTL} ${y}`,
    ].filter(Boolean);

    if (segs.length === 0) return;

    const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stroke.setAttribute("d", segs.join(' '));
    stroke.setAttribute("fill", "none");
    stroke.setAttribute("stroke", color);
    stroke.setAttribute("stroke-width", String(strokeWidth));
    stroke.setAttribute("stroke-linecap", "butt");
    svg.appendChild(stroke);
}

function drawSVGLoops(solution, numVars, rowsBits, colsBits, rowGray, colGray, is3D, zOffset, scale = 1) {
    const svg = document.getElementById('kmap-svg-overlay');
    if (!is3D) {
        svg.innerHTML = '';
        svg.setAttribute('width', svg.parentElement.clientWidth);
        svg.setAttribute('height', svg.parentElement.clientHeight);
    }
    
    if (!solution || solution.length === 0) return;

    const wrapperRect = svg.parentElement.getBoundingClientRect();
    const zBits = numVars - rowsBits - colsBits;

    // Pass 1: for every group, split it into non-wrapping rectangular pieces
    // — a group needs more than one piece only when it wraps around an edge
    // of the map (e.g. a four-corners group needs four small pieces instead
    // of one box covering the whole map) — and compute each piece's raw
    // (un-padded) pixel box.
    const pieces = [];
    solution.forEach((term, idx) => {
        // A selection restricts which group(s) get drawn, but idx (and so
        // color) still comes from this term's position in the full solution —
        // selecting doesn't recolor anything, only hides the rest.
        if (_selectedImplicantTerm !== null && term !== _selectedImplicantTerm) return;

        const zPart = term.slice(0, zBits);
        for (let k = 0; k < zBits; k++) {
            if (zPart[k] !== '-' && zPart[k] !== zOffset[k]) return; // term doesn't touch this plane
        }
        const rowBits = term.slice(zBits, zBits + rowsBits);
        const colBits = term.slice(zBits + rowsBits, zBits + rowsBits + colsBits);

        const rowPresent = rowGray.map(g => {
            for (let k = 0; k < rowsBits; k++) if (rowBits[k] !== '-' && rowBits[k] !== g[k]) return false;
            return true;
        });
        const colPresent = colGray.map(g => {
            for (let k = 0; k < colsBits; k++) if (colBits[k] !== '-' && colBits[k] !== g[k]) return false;
            return true;
        });
        if (!rowPresent.some(Boolean) || !colPresent.some(Boolean)) return;

        const rowRuns = computeAxisRuns(rowPresent);
        const colRuns = computeAxisRuns(colPresent);

        rowRuns.forEach(rowRun => {
            colRuns.forEach(colRun => {
                const tlBin = zOffset + rowGray[rowRun.lo] + colGray[colRun.lo];
                const brBin = zOffset + rowGray[rowRun.hi] + colGray[colRun.hi];
                const tlCell = document.getElementById(`kmap-cell-${parseInt(tlBin, 2)}`);
                const brCell = document.getElementById(`kmap-cell-${parseInt(brBin, 2)}`);
                if (!tlCell || !brCell) return;

                const tlRect = tlCell.getBoundingClientRect();
                const brRect = brCell.getBoundingClientRect();

                pieces.push({
                    idx,
                    rect: {
                        minX: tlRect.left - wrapperRect.left,
                        minY: tlRect.top - wrapperRect.top,
                        maxX: brRect.right - wrapperRect.left,
                        maxY: brRect.bottom - wrapperRect.top
                    },
                    rowLo: rowRun.lo, rowHi: rowRun.hi,
                    colLo: colRun.lo, colHi: colRun.hi,
                    wrapTop: rowRun.wrapLow,
                    wrapBottom: rowRun.wrapHigh,
                    wrapLeft: colRun.wrapLow,
                    wrapRight: colRun.wrapHigh
                });
            });
        });
    });

    if (pieces.length === 0) return;

    // Pass 2: figure out which pieces share an overlapping edge (checked in
    // grid-cell coordinates, not pixels - see computeAntiOverlapShrinkGrid).
    // This returns a per-edge (top/bottom/left/right) shrink per piece, not
    // a single scalar — a piece only pulls back on the specific side(s)
    // that actually conflict with another group, and a conflict on one
    // fragment of a wrapped group no longer bleeds into shrinking that
    // group's other, unrelated fragments elsewhere on the map.
    const extraShrink = computeAntiOverlapShrinkGrid(pieces.map(p => ({
        idx: p.idx, rowLo: p.rowLo, rowHi: p.rowHi, colLo: p.colLo, colHi: p.colHi
    })));

    // Pass 3: draw, using the base pad plus any anti-overlap shrink - both
    // scaled down with the map itself, so a shrunk K-map gets proportionally
    // thinner gaps/borders instead of the same fixed pixel amounts eating up
    // a much bigger share of its smaller cells. Wrap edges are drawn dashed
    // instead of solid.
    pieces.forEach((piece, i) => {
        const color = LOOP_COLORS[piece.idx % LOOP_COLORS.length];
        const r = piece.rect;
        const s = extraShrink[i];
        // Wrap sides must stay flush against the map's edge — a piece is
        // only padded away from the wall on the sides that are real
        // boundaries, so the cropped/open side always touches the wall
        // instead of leaving a gap.
        const padTop = piece.wrapTop ? 0 : (5 + s.top) * scale;
        const padBottom = piece.wrapBottom ? 0 : (5 + s.bottom) * scale;
        const padLeft = piece.wrapLeft ? 0 : (5 + s.left) * scale;
        const padRight = piece.wrapRight ? 0 : (5 + s.right) * scale;
        const w = Math.max(2, (r.maxX - r.minX) - padLeft - padRight);
        const h = Math.max(2, (r.maxY - r.minY) - padTop - padBottom);
        drawLoopPieceSVG(svg, r.minX + padLeft, r.minY + padTop, w, h, color, {
            top: piece.wrapTop, bottom: piece.wrapBottom, left: piece.wrapLeft, right: piece.wrapRight
        }, scale);
    });
}

function renderMultiple2DKMaps(numVars, variables, minterms, dontCares, activeSolution, isSOP) {
    const container = document.getElementById('kmap-grid-container');
    const svgOverlay = document.getElementById('kmap-svg-overlay');
    const wrapper3d = document.getElementById('kmap-3d-container');
    const wrapContainer = document.getElementById('kmap-wrap-container');

    if (typeof _stopKmap3DAnimLoops === 'function') _stopKmap3DAnimLoops();
    container.style.display = 'grid';
    container.style.gap = '20px';
    container.style.justifyContent = 'center';
    container.style.alignItems = 'center';
    container.style.gridTemplateColumns = 'repeat(2, max-content)';
    container.classList.remove('kmap-small');
    container.style.transform = 'none'; // reset before measure
    
    svgOverlay.style.display = 'block';

    if(wrapper3d) wrapper3d.style.display = 'none';
    if(wrapContainer) wrapContainer.style.display = 'none';

    const subVars = variables.slice(numVars - 4);
    const rowVars = subVars.slice(0, 2);
    const colVars = subVars.slice(2);
    
    const rowGray = getGrayCodeStr(2);
    const colGray = getGrayCodeStr(2);
    
    const numPlanes = (numVars === 5) ? 2 : 4;
    const zVars = variables.slice(0, numVars - 4);
    const zGray = getGrayCodeStr(numVars - 4);
    
    let html = '';
    for (let z = 0; z < numPlanes; z++) {
        const zPrefix = zGray[z];
        const planeName = zVars.map((v, idx) => `${v}=${zPrefix[idx]}`).join(', ');
        
        html += `<div class="kmap-plane-wrapper" style="text-align:center;">`;
        html += `<div style="font-weight:bold; margin-bottom: 10px; color:var(--accent);">${planeName}</div>`;
        html += '<table class="kmap-table" style="margin: 0 auto;">';
        html += `<tr><th class="kmap-corner" style="position: relative; padding: 0; min-width: 40px; height: 40px;"><svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="100%" stroke="var(--border)" stroke-width="1.5" /></svg><div class="kmap-corner-col">${colVars.join('')}</div><div class="kmap-corner-row">${rowVars.join('')}</div></th>`;
        for (let c of colGray) { html += `<th style="height: 40px; vertical-align: bottom; padding-bottom: 2px;">${c}</th>`; }
        html += '</tr>';
        
        for (let r = 0; r < rowGray.length; r++) {
            html += `<tr><th style="width: 40px; text-align: right; padding-right: 4px;">${rowGray[r]}</th>`;
            for (let c = 0; c < colGray.length; c++) {
                const binStr = zPrefix + rowGray[r] + colGray[c];
                const minterm = parseInt(binStr, 2);
                let val = '0';
                if (minterms.includes(minterm)) val = '1';
                if (dontCares.includes(minterm)) val = 'X';
                
                html += `<td id="kmap-cell-${minterm}" class="kmap-cell val-${val}" data-minterm="${minterm}" onclick="handleKMapCellClick(${minterm})">`;
                html += `<div class="kmap-minterm-label">${minterm}</div>`;
                html += `${val}</td>`;
            }
            html += '</tr>';
        }
        html += '</table></div>';
    }
    container.innerHTML = html;

    // Synchronous scale computation
    const wrapper = document.getElementById('kmap-visual-wrapper');
    const rect = container.getBoundingClientRect();
    const isMobileKMap = window.innerWidth <= 900;
    // Fit to the available space on every screen size, same as desktop -
    // the visual panel never scrolls, it scales the planes down (or up,
    // within limits) to fit exactly what's available on both axes.
    const pad = isMobileKMap ? 24 : 40;
    const availW = wrapper.clientWidth - pad;
    const availH = wrapper.clientHeight - pad;
    let scale = Math.min(availW / rect.width, availH / rect.height);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    if (isMobileKMap) {
        scale = Math.min(scale, 1); // never enlarge past default size on mobile
    } else if (scale > 1.6) {
        scale = 1.6;
    }
    
    container.style.transform = `scale(${scale})`;
    container.style.transformOrigin = 'center center';
    
    // See render2DKMap for why the clear happens inside the rAF, in the
    // same tick as the redraw, instead of before it.
    requestAnimationFrame(() => {
        svgOverlay.setAttribute('width', svgOverlay.parentElement.clientWidth);
        svgOverlay.setAttribute('height', svgOverlay.parentElement.clientHeight);
        svgOverlay.innerHTML = '';
        for (let z = 0; z < numPlanes; z++) {
            const zPrefix = zGray[z];
            drawSVGLoops(activeSolution, numVars, 2, 2, rowGray, colGray, true, zPrefix, scale);
        }
    });
}

function binaryToVariables(binaryStr, variables, isPOS) {
    let term = isPOS ? "(" : "";
    let first = true;
    for (let j = 0; j < Math.min(binaryStr.length, variables.length); j++) {
        let bit = binaryStr[j];
        if (bit !== '-') {
            if (!first && isPOS) {
                term += "+";
            }
            term += variables[j];
            if (isPOS ? (bit === '1') : (bit === '0')) {
                term += "'";
            }
            first = false;
        }
    }
    if (isPOS) term += ")";
    if (term === "" || term === "()") return isPOS ? "0" : "1";
    return term;
}

function renderKMapAnalysis(solution, isSOP, variables) {
    const list = document.getElementById('kmap-implicants-list');
    if (!list) return;

    if (!lastKMapData) {
        list.innerHTML = '<div class="empty-msg">No data available.</div>';
        return;
    }

    const { minterms, dontCares, primeImplicants, essentialPrimeImplicants, primeImplicantsPOS, essentialPrimeImplicantsPOS } = lastKMapData;
    
    // We need to calculate maxterms for POS Canonical form
    const numVars = variables.length;
    const maxCells = Math.pow(2, numVars);
    let maxterms = [];
    for (let i = 0; i < maxCells; i++) {
        if (!minterms.includes(i) && !dontCares.includes(i)) {
            maxterms.push(i);
        }
    }

    // Small helper: one card = uppercase label (+ optional count chip) + body.
    const card = (iconCls, iconText, title, count, bodyHtml) => {
        // Only Minimal Expression stays expanded by default; Canonical, EPI, and NEPI start collapsed
        const isOpen = iconCls === 'minimal' ? 'open' : '';
        return `
        <details class="kmap-analysis-section" ${isOpen}>
            <summary class="kmap-analysis-header">
                <span class="kmap-analysis-title">${title}</span>
                ${count != null ? `<span class="kmap-analysis-count">${count}</span>` : ''}
                <svg class="kmap-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </summary>
            <div class="kmap-analysis-body">
                ${bodyHtml}
            </div>
        </details>`;
    };

    let cardsHtml = '';

    // 1. Canonical Form
    if (isSOP) {
        const literals = minterms.map(m => {
            let bin = m.toString(2).padStart(numVars, '0');
            return binaryToVariables(bin, variables, false);
        });
        const body = `
            <div class="kmap-analysis-subtitle">Σm(${minterms.join(', ')})</div>
            <div class="term-boxes-container">${literals.map(l => `<span class="term-box">${l}</span>`).join('')}</div>`;
        cardsHtml += card('canonical-sop', 'Σ', 'Canonical Form (SOP)', minterms.length, body);
    } else {
        const literals = maxterms.map(m => {
            let bin = m.toString(2).padStart(numVars, '0');
            return binaryToVariables(bin, variables, true);
        });
        const body = `
            <div class="kmap-analysis-subtitle">Πm(${maxterms.join(', ')})</div>
            <div class="term-boxes-container">${literals.map(l => `<span class="term-box">${l}</span>`).join('')}</div>`;
        cardsHtml += card('canonical-pos', 'Π', 'Canonical Form (POS)', maxterms.length, body);
    }

    // 2. Minimal Expression
    {
        let minimalBody;
        if (!solution || solution.length === 0) {
            minimalBody = `<div class="kmap-analysis-empty">0</div>`;
        } else {
            let colorIdx = 0;
            const solutionHtml = solution.map(term => {
                const color = LOOP_COLORS[colorIdx % LOOP_COLORS.length];
                colorIdx++;
                const literal = binaryToVariables(term, variables, !isSOP);
                const isSelected = term === _selectedImplicantTerm;
                const isDimmed = _selectedImplicantTerm !== null && !isSelected;
                const cls = `term-box selectable-implicant${isSelected ? ' selected' : ''}${isDimmed ? ' dimmed' : ''}`;
                return `<span class="${cls}" data-term="${term}" onclick="selectImplicantGroup('${term}')" style="border:1px solid ${color}; color:${color}; background:${color}20;">${literal}</span>`;
            }).join('');
            minimalBody = `<div class="term-boxes-container">${solutionHtml}</div>`;
        }
        cardsHtml += card('minimal', '∴', 'Minimal Expression', solution ? solution.length : 0, minimalBody);
    }

    // 3. Prime Implicants
    const activePIs = isSOP ? primeImplicants : primeImplicantsPOS;
    const activeEPIs = isSOP ? essentialPrimeImplicants : essentialPrimeImplicantsPOS;

    if (activeEPIs && activeEPIs.length > 0) {
        const epiHtml = activeEPIs.map(epi => {
            const literal = binaryToVariables(epi, variables, !isSOP);
            const isSelected = epi === _selectedImplicantTerm;
            const isDimmed = _selectedImplicantTerm !== null && !isSelected;
            const cls = `term-box selectable-implicant${isSelected ? ' selected' : ''}${isDimmed ? ' dimmed' : ''}`;
            return `<span class="${cls}" data-term="${epi}" onclick="selectImplicantGroup('${epi}')" style="border:1px solid #AF52DE; color:#AF52DE;">${literal}</span>`;
        }).join('');
        cardsHtml += card('epi', 'EPI', 'Essential Prime Implicants', activeEPIs.length, `<div class="term-boxes-container">${epiHtml}</div>`);
    }

    let nonEPIs = [];
    if (activePIs) {
        nonEPIs = activePIs.filter(pi => !activeEPIs.includes(pi));
    }

    if (nonEPIs && nonEPIs.length > 0) {
        const nepiHtml = nonEPIs.map(nepi => {
            const literal = binaryToVariables(nepi, variables, !isSOP);
            return `<span class="term-box" style="border:1px solid #007AFF; color:#007AFF;">${literal}</span>`;
        }).join('');
        cardsHtml += card('nepi', 'PI', 'Non-Essential Prime Implicants', nonEPIs.length, `<div class="term-boxes-container">${nepiHtml}</div>`);
    }

    list.innerHTML = `<div class="kmap-analysis-board">${cardsHtml}</div>`;
}

// ── 3D K-Map: a real WebGL cube lattice (Three.js) ───────────────────────────
//
// Every K-map cell is an actual cube positioned on a 3D grid (columns × rows ×
// layers, one axis per pair of variables). Design goals:
//   1. Real depth, not simulated depth — cubes further from the camera are
//      genuinely further away, so orbiting the scene actually reveals them.
//   2. Cubes use a transparent, low-opacity fill (`transparent: true` +
//      low `opacity`) so outer cells don't block sight/light to inner ones,
//      while a bright wireframe edge on every cube keeps each cell's
//      boundary crisp no matter how faint the fill is.
//   3. Color encodes the cell's value: green = minterm (1), red = don't-care
//      (X), gray = 0 — so the whole cube shows the map's shape at a glance.
//   4. An Explode toggle animates every cube apart along all three axes,
//      opening up gaps so interior cells are easy to reach/inspect.
//   5. A Wireframe-only toggle drops the solid fill entirely (edges only, in
//      each cell's category color) for a pure structural view.
//   6. Prime-implicant groups from the active minimal solution are drawn as
//      colored wireframe bounding boxes wrapped around their member cubes —
//      so groupings that span rows/columns/layers are visible as real 3D
//      boxes, the way they'd be drawn as loops on a flat K-map.
// Clicking a cube toggles that minterm (0 → 1 → X → 0), same as the 2D view.

let kmap3DState = {
    exploded: false,
    wireframeOnly: false,
    _ctx: null,
    _raf: null,
    _renderer: null,
    _scene: null,
    _camera: null,
    _cubes: [],        // { mesh, edges, outline, material, r, c, l, minterm, val, base:{x,y,z}, exploded:{x,y,z} }
    _groupHelpers: [],
    _rot: { theta: 0.7, phi: 1.05, radius: 8.5 },
    _vel: { theta: 0, phi: 0 },
    _drag: { active: false, moved: false, startX: 0, startY: 0, lastX: 0, lastY: 0 },
    _resizeObserver: null,
    _resizeHandler: null
};

function _stopKmap3DAnimLoops() {
    if (kmap3DState._raf) cancelAnimationFrame(kmap3DState._raf);
    kmap3DState._raf = null;
    if (kmap3DState._resizeHandler) {
        window.removeEventListener('resize', kmap3DState._resizeHandler);
        kmap3DState._resizeHandler = null;
    }
    if (kmap3DState._windowMoveHandler) {
        window.removeEventListener('mousemove', kmap3DState._windowMoveHandler);
        kmap3DState._windowMoveHandler = null;
    }
    if (kmap3DState._windowUpHandler) {
        window.removeEventListener('mouseup', kmap3DState._windowUpHandler);
        kmap3DState._windowUpHandler = null;
    }
    if (kmap3DState._resizeObserver) {
        kmap3DState._resizeObserver.disconnect();
        kmap3DState._resizeObserver = null;
    }
    if (kmap3DState._renderer) {
        kmap3DState._renderer.dispose();
        kmap3DState._renderer = null;
    }
    kmap3DState._scene = null;
    kmap3DState._camera = null;
    kmap3DState._cubes = [];
    kmap3DState._groupHelpers = [];
    kmap3DState._ctx = null;
}

const KMAP3D_COLOR = { one: 0x34C759, dc: 0x8A8F98, zero: 0xFF3B30 };
const KMAP3D_OPACITY = { one: 0.55, dc: 0.2, zero: 0.32 };

function _getKMap3DFitRadius(w, h) {
    const aspect = w / h;
    // 11 is a perfect baseline to fit the exploded 6-variable map on desktop.
    // If the screen is narrow (portrait), pull back proportionally.
    return aspect < 1 ? 11 / aspect : 11;
}

function render3DKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP) {
    const container = document.getElementById('kmap-grid-container');
    const svgOverlay = document.getElementById('kmap-svg-overlay');
    const wrapper3d = document.getElementById('kmap-3d-container');
    const wrapContainer = document.getElementById('kmap-wrap-container');

    container.style.display = 'none';
    svgOverlay.style.display = 'none';
    wrapper3d.style.display = 'block';
    if (wrapContainer) wrapContainer.style.display = 'none';

    // Capture the outgoing lattice's numVars BEFORE tearing anything down -
    // _stopKmap3DAnimLoops() below wipes kmap3DState._ctx as part of its
    // cleanup, so reading it any later would always see null and make the
    // "did the shape actually change" check further down always true,
    // resetting the user's zoom/pan on every re-render (e.g. every cell
    // click), not just on a genuine numVars change.
    const prevNumVars = kmap3DState._ctx ? kmap3DState._ctx.numVars : null;

    _stopKmap3DAnimLoops();
    wrapper3d.innerHTML = '';

    if (typeof THREE === 'undefined') {
        wrapper3d.innerHTML = '<div class="empty-msg" style="padding:40px;">3D engine failed to load.</div>';
        return;
    }

    const numLayers = (numVars === 5) ? 2 : 4;
    const zVars = variables.slice(0, numVars - 4);
    const zGray = getGrayCodeStr(numVars - 4);
    const rowVars = variables.slice(numVars - 4, numVars - 2);
    const colVars = variables.slice(numVars - 2, numVars);
    const rowGray = getGrayCodeStr(2);
    const colGray = getGrayCodeStr(2);

    let html = `<div class="kmap-3d-toolbar">
                    <div class="kmap-3d-tbtn" id="kmap3d-explode-btn" title="Explode / collapse the lattice">${_kmap3dIcon('explode')}</div>
                    <div class="kmap-3d-tbtn" id="kmap3d-wireframe-btn" title="Wireframe-only mode">${_kmap3dIcon('wireframe')}</div>
                    <div class="kmap-3d-tbtn" id="kmap3d-reset-btn" title="Reset view">${_kmap3dIcon('reset')}</div>
                </div>`;
    html += `<div class="kmap-3d-legend">
                    <span><i style="background:#34C759"></i>1</span>
                    <span><i style="background:#FF3B30"></i>0</span>
                    <span><i style="background:#8A8F98"></i>X</span>
                </div>`;
    html += `<div class="kmap-3d-canvas-wrap" id="kmap-3d-canvas-wrap"></div>`;
    html += `<div class="kmap-3d-controls"><span class="ctrl-hint">Drag to rotate &bull; scroll to zoom &bull; click a cube to toggle it &bull; Explode pulls the lattice apart</span></div>`;
    wrapper3d.innerHTML = html;

    const canvasWrap = document.getElementById('kmap-3d-canvas-wrap');
    const width = canvasWrap.clientWidth || 600;
    const height = canvasWrap.clientHeight || 380;

    // A cell click just toggles a minterm and re-renders the same lattice -
    // it shouldn't discard whatever zoom/pan the user had set (pinch on
    // mobile, wheel on desktop). Only snap back to the auto-fit radius the
    // first time this view is built, or when the lattice's shape actually
    // changes (numVars changed, e.g. switching between a 4-var and 5-var
    // K-map), since the fit radius depends on that shape.
    if (prevNumVars === null || prevNumVars !== numVars) {
        kmap3DState._rot.radius = _getKMap3DFitRadius(width, height);
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    canvasWrap.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(5, 7, 6);
    scene.add(dirLight);

    kmap3DState._renderer = renderer;
    kmap3DState._scene = scene;
    kmap3DState._camera = camera;
    kmap3DState._ctx = { numVars, variables, minterms, dontCares, activeSolution, isSOP, numLayers, zGray, rowGray, colGray, zVars, rowVars, colVars };


    // ── Build the cube lattice ──
    const cubeSize = 0.85;
    const spacing = 1.25;     // base center-to-center spacing
    const explodeGap = 1.45;  // extra spacing added per step when exploded

    const axisPos = (idx, count, gap) => (idx - (count - 1) / 2) * gap;

    const cubeGeo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
    const edgesGeo = new THREE.EdgesGeometry(cubeGeo);
    const sphereGeo = new THREE.SphereGeometry(cubeSize * 0.16, 16, 12);

    kmap3DState._cubes = [];

    for (let l = 0; l < numLayers; l++) {
        for (let r = 0; r < rowGray.length; r++) {
            for (let c = 0; c < colGray.length; c++) {
                const binStr = zGray[l] + rowGray[r] + colGray[c];
                const minterm = parseInt(binStr, 2);
                let val = '0';
                if (minterms.includes(minterm)) val = '1';
                if (dontCares.includes(minterm)) val = 'X';

                // The box itself is always neutral gray now — only the small
                // sphere at its center encodes the cell's value (1/0/X), so
                // the lattice's shape is legible without every cube fighting
                // for attention with its own color.
                const colorKey = val === '1' ? 'one' : (val === 'X' ? 'dc' : 'zero');
                const stateColor = KMAP3D_COLOR[colorKey];
                const boxColor = KMAP3D_COLOR.dc;

                const material = new THREE.MeshStandardMaterial({
                    color: boxColor,
                    transparent: true,
                    opacity: KMAP3D_OPACITY.dc,
                    depthWrite: false,
                    side: THREE.DoubleSide
                });
                const mesh = new THREE.Mesh(cubeGeo, material);
                mesh.visible = !kmap3DState.wireframeOnly;

                // Shown only in wireframe-only mode; normal mode uses a faint neutral outline instead.
                const edges = _makeThickCubeEdges(edgesGeo, boxColor, 0.65);
                edges.visible = false;

                const outline = _makeThickCubeEdges(edgesGeo, 0xffffff, 0.45);
                outline.visible = !kmap3DState.wireframeOnly;

                const sphereMat = new THREE.MeshStandardMaterial({ color: stateColor, roughness: 0.35, metalness: 0.1 });
                const sphere = new THREE.Mesh(sphereGeo, sphereMat);

                const label = _makeKMap3DLabel(minterm);
                label.position.set(0, cubeSize / 2 + 0.28, 0);

                // A holder group carries position/explode animation for the
                // cube's whole visual (box + edges + outline + sphere +
                // label). Keeping the sphere as a sibling here — rather than
                // a child of `mesh` — means toggling mesh/edges visibility
                // for wireframe mode never hides the state sphere.
                const holder = new THREE.Group();
                holder.add(mesh);
                holder.add(edges);
                holder.add(outline);
                holder.add(sphere);
                holder.add(label);

                const base = {
                    x: axisPos(c, colGray.length, spacing),
                    y: -axisPos(l, numLayers, spacing),
                    z: axisPos(r, rowGray.length, spacing)
                };
                const exploded = {
                    x: axisPos(c, colGray.length, spacing + explodeGap),
                    y: -axisPos(l, numLayers, spacing + explodeGap),
                    z: axisPos(r, rowGray.length, spacing + explodeGap)
                };
                // Start already at whatever layout is currently active (base or exploded) —
                // otherwise every re-render (e.g. after toggling a cell's value) would snap
                // back to collapsed and replay the explode animation from scratch.
                const startPos = kmap3DState.exploded ? exploded : base;
                holder.position.set(startPos.x, startPos.y, startPos.z);
                mesh.userData.minterm = minterm;

                scene.add(holder);
                kmap3DState._cubes.push({ mesh, holder, edges, outline, sphere, material, r, c, l, minterm, val, base, exploded });
            }
        }
    }

    // Small floor labels showing which z-bits each layer represents, so the
    // now-vertical layer axis (top layer = lowest z-bit combination) stays
    // legible.
    if (zVars.length > 0) {
        for (let l = 0; l < numLayers; l++) {
            const text = `${zVars.join('')}=${zGray[l]}`;
            const tag = _makeKMap3DLabel(text, true);
            const tagX = axisPos(0, colGray.length, spacing) - 1.3;
            const tagZ = axisPos(0, rowGray.length, spacing) + 1.3;
            const baseY = -axisPos(l, numLayers, spacing);
            const explodedY = -axisPos(l, numLayers, spacing + explodeGap);
            tag.userData.isLayerTag = true;
            const startY = kmap3DState.exploded ? explodedY : baseY;
            tag.position.set(tagX, startY, tagZ);
            scene.add(tag);
            kmap3DState._cubes.push({ mesh: tag, isLayerTag: true, base: { x: tagX, y: baseY, z: tagZ }, exploded: { x: tagX, y: explodedY, z: tagZ } });
        }
    }

    _updateKMap3DGroupHelpers();
    _updateKMap3DToolbarUI();
    _wireKMap3DInteractions();
    _updateKMap3DCamera();

    kmap3DState._raf = requestAnimationFrame(_kmap3DAnimate);
}

// Builds a cube-edge outline that reads as visibly thicker than a plain
// LineSegments, which is necessary because WebGL/ANGLE ignores
// LineBasicMaterial.linewidth in Chromium-based browsers (it always renders
// at 1px there regardless of the value set). Layering a slightly larger,
// softer "halo" line behind a crisp full-opacity line gives real, consistent
// thickness across browsers without needing an extra fat-lines library.
function _makeThickCubeEdges(edgesGeo, color, opacity) {
    const group = new THREE.Group();

    const haloMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacity * 0.5, linewidth: 2 });
    const halo = new THREE.LineSegments(edgesGeo, haloMat);
    halo.scale.setScalar(1.045);
    group.add(halo);

    const coreMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, linewidth: 2 });
    const core = new THREE.LineSegments(edgesGeo, coreMat);
    group.add(core);

    return group;
}

// Small billboard sprite carrying a number/label, built from a canvas texture.
function _makeKMap3DLabel(text, muted) {
    const str = String(text);
    // Muted labels (e.g. "AB=01") are wider than tall; give the canvas that
    // same aspect ratio so the sprite scale doesn't have to squash/stretch a
    // square texture (which is what was distorting and cropping the text).
    const cw = muted ? 256 : 128;
    const ch = muted ? 128 : 128;

    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = muted ? 'rgba(148,163,184,0.95)' : 'rgba(255,255,255,0.95)';

    // Shrink the font until the text fits within the canvas with some margin,
    // so longer labels never get cropped.
    const maxWidth = cw * 0.86;
    let fontSize = muted ? 52 : 56;
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    while (ctx.measureText(str).width > maxWidth && fontSize > 16) {
        fontSize -= 2;
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    }
    ctx.fillText(str, cw / 2, ch / 2 + fontSize * 0.05);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteH = muted ? 0.42 : 0.42;
    sprite.scale.set(spriteH * (cw / ch), spriteH, 1);
    return sprite;
}

// Rebuilds the colored wireframe bounding boxes around each prime-implicant
// group in the active solution. Called on load and again whenever the
// lattice's cube positions change (explode toggle), since the boxes must
// track the cubes they wrap.
//
// Given a boolean membership array over a cyclic axis in 3D world space
// (already padded box coordinates), figures out extra inset per box so that
// any pair of boxes sharing a full face (overlapping on the other two axes,
// with a matching boundary plane) end up visibly separated instead of their
// borders sitting flush against each other. Mirrors computeAntiOverlapShrink
// for the 2D view, just extended to three axes.
function computeAntiOverlapShrink3D(boxes) {
    const n = boxes.length;
    const extra = new Array(n).fill(0);
    const eps = 0.05;

    for (let i = 0; i < n; i++) {
        if (!boxes[i]) continue;
        for (let j = i + 1; j < n; j++) {
            if (!boxes[j]) continue;
            const a = boxes[i], b = boxes[j];

            const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
            const yOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
            const zOverlap = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);

            const sameXPlane = Math.abs(a.minX - b.minX) < eps || Math.abs(a.minX - b.maxX) < eps ||
                                Math.abs(a.maxX - b.minX) < eps || Math.abs(a.maxX - b.maxX) < eps;
            const sameYPlane = Math.abs(a.minY - b.minY) < eps || Math.abs(a.minY - b.maxY) < eps ||
                                Math.abs(a.maxY - b.minY) < eps || Math.abs(a.maxY - b.maxY) < eps;
            const sameZPlane = Math.abs(a.minZ - b.minZ) < eps || Math.abs(a.minZ - b.maxZ) < eps ||
                                Math.abs(a.maxZ - b.minZ) < eps || Math.abs(a.maxZ - b.maxZ) < eps;

            const sharesFace = (yOverlap > eps && zOverlap > eps && sameXPlane) ||
                                (xOverlap > eps && zOverlap > eps && sameYPlane) ||
                                (xOverlap > eps && yOverlap > eps && sameZPlane);

            if (sharesFace) {
                extra[j] = Math.min(extra[j] + 0.07, 0.22);
            }
        }
    }
    return extra;
}

// Builds a thick cylinder ("tube") mesh running between two points in a
// group's local space. Used instead of THREE.Line so the edge has real
// geometric thickness (WebGL/ANGLE ignores LineBasicMaterial.linewidth in
// Chromium-based browsers).
function _makeEdgeTube(p1, p2, radius, material) {
    const a = new THREE.Vector3(p1[0], p1[1], p1[2]);
    const b = new THREE.Vector3(p2[0], p2[1], p2[2]);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-6) return null;

    const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
}

// Adds one box edge (from p1 to p2) to the group as a thick, fully opaque
// tube — solid edges become a single tube, dashed edges (those touching a
// wrap face) are broken into short dash tubes with gaps, so the box reads
// as "this keeps going" rather than a hard boundary. This is real cylinder
// geometry (not THREE.Line), so a single opaque tube already has genuine
// on-screen thickness from every angle — no translucent "halo" layer is
// needed to fake it, and adding one only made some sides look see-through.
function _addGroupBoxEdge(group, p1, p2, dashed, material) {
    const add = (a, b) => {
        const core = _makeEdgeTube(a, b, 0.032, material);
        if (core) group.add(core);
    };

    if (!dashed) { add(p1, p2); return; }

    const a = new THREE.Vector3(p1[0], p1[1], p1[2]);
    const b = new THREE.Vector3(p2[0], p2[1], p2[2]);
    const total = a.distanceTo(b);
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const dash = 0.16, gap = 0.13;
    let t = 0;
    while (t < total) {
        const segEnd = Math.min(t + dash, total);
        const sa = a.clone().addScaledVector(dir, t);
        const sb = a.clone().addScaledVector(dir, segEnd);
        add([sa.x, sa.y, sa.z], [sb.x, sb.y, sb.z]);
        t += dash + gap;
    }
}

// Builds a box wireframe as thick tube edges. wrapFaces flags the box's
// low/high side on each axis that is a "wrap" face — i.e. the group
// actually continues on the opposite side of the lattice there rather than
// truly ending — and edges touching such a face are drawn dashed instead of
// solid, so the box reads as "this keeps going" rather than a hard boundary.
function _makeGroupBoxWireframe(box, colorHex, wrapFaces) {
    const center = box.getCenter(new THREE.Vector3());
    let x0 = box.min.x - center.x, x1 = box.max.x - center.x;
    let y0 = box.min.y - center.y, y1 = box.max.y - center.y;
    let z0 = box.min.z - center.z, z1 = box.max.z - center.z;

    // A wrap face is pushed out a bit further than the box's real boundary
    // (rather than stopping flush there), so that side visibly overshoots
    // the wall — reading as "this keeps going past the edge" instead of a
    // hard stop, which is easy to miss when it's just dashed in place.
    const WRAP_EXTEND = 0.28;
    if (wrapFaces.xLow) x0 -= WRAP_EXTEND;
    if (wrapFaces.xHigh) x1 += WRAP_EXTEND;
    if (wrapFaces.yLow) y0 -= WRAP_EXTEND;
    if (wrapFaces.yHigh) y1 += WRAP_EXTEND;
    if (wrapFaces.zLow) z0 -= WRAP_EXTEND;
    if (wrapFaces.zHigh) z1 += WRAP_EXTEND;

    const group = new THREE.Group();
    group.position.copy(center);

    // Fully opaque — no transparency, so coverage never depends on
    // camera-angle-dependent sort order between overlapping objects.
    const material = new THREE.MeshBasicMaterial({ color: colorHex, transparent: false, opacity: 1 });

    const addEdge = (p1, p2, dashed) => _addGroupBoxEdge(group, p1, p2, dashed, material);

    // Edges running along X (fixed y,z) — each touches a Y face and a Z face.
    addEdge([x0, y0, z0], [x1, y0, z0], wrapFaces.yLow || wrapFaces.zLow);
    addEdge([x0, y0, z1], [x1, y0, z1], wrapFaces.yLow || wrapFaces.zHigh);
    addEdge([x0, y1, z0], [x1, y1, z0], wrapFaces.yHigh || wrapFaces.zLow);
    addEdge([x0, y1, z1], [x1, y1, z1], wrapFaces.yHigh || wrapFaces.zHigh);

    // Edges running along Y (fixed x,z) — each touches an X face and a Z face.
    addEdge([x0, y0, z0], [x0, y1, z0], wrapFaces.xLow || wrapFaces.zLow);
    addEdge([x0, y0, z1], [x0, y1, z1], wrapFaces.xLow || wrapFaces.zHigh);
    addEdge([x1, y0, z0], [x1, y1, z0], wrapFaces.xHigh || wrapFaces.zLow);
    addEdge([x1, y0, z1], [x1, y1, z1], wrapFaces.xHigh || wrapFaces.zHigh);

    // Edges running along Z (fixed x,y) — each touches an X face and a Y face.
    addEdge([x0, y0, z0], [x0, y0, z1], wrapFaces.xLow || wrapFaces.yLow);
    addEdge([x1, y0, z0], [x1, y0, z1], wrapFaces.xHigh || wrapFaces.yLow);
    addEdge([x0, y1, z0], [x0, y1, z1], wrapFaces.xLow || wrapFaces.yHigh);
    addEdge([x1, y1, z0], [x1, y1, z1], wrapFaces.xHigh || wrapFaces.yHigh);

    return group;
}

function _updateKMap3DGroupHelpers() {
    const ctx = kmap3DState._ctx;
    const scene = kmap3DState._scene;
    if (!ctx || !scene) return;

    kmap3DState._groupHelpers.forEach(h => {
        scene.remove(h);
        h.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
    });
    kmap3DState._groupHelpers = [];

    const { activeSolution, numLayers, zGray, rowGray, colGray } = ctx;
    if (!activeSolution || activeSolution.length === 0) return;
    const zBits = ctx.numVars - 4;
    const basePad = 0.55;

    // Pass 1: split every group into non-wrapping pieces (a group only needs
    // more than one piece when it wraps around an edge of the lattice, e.g.
    // a group spanning the two outer layers), and gather each piece's member
    // cubes and wrap-face flags.
    const pieces = []; // { color, members, wrapFaces }
    activeSolution.forEach((term, idx) => {
        // Selection filters which group gets a wireframe drawn; color still
        // comes from this term's position in the full solution, unchanged.
        if (_selectedImplicantTerm !== null && term !== _selectedImplicantTerm) return;

        const colorStr = LOOP_COLORS[idx % LOOP_COLORS.length];
        const color = parseInt(colorStr.slice(1), 16);
        const zPart = term.slice(0, zBits);
        const rowBits = term.slice(zBits, zBits + 2);
        const colBits = term.slice(zBits + 2, zBits + 4);

        const layerPresent = [];
        for (let l = 0; l < numLayers; l++) {
            let ok = true;
            for (let k = 0; k < zBits; k++) { if (zPart[k] !== '-' && zPart[k] !== zGray[l][k]) { ok = false; break; } }
            layerPresent.push(ok);
        }
        const rowPresent = rowGray.map(g => {
            for (let k = 0; k < 2; k++) if (rowBits[k] !== '-' && rowBits[k] !== g[k]) return false;
            return true;
        });
        const colPresent = colGray.map(g => {
            for (let k = 0; k < 2; k++) if (colBits[k] !== '-' && colBits[k] !== g[k]) return false;
            return true;
        });
        if (!layerPresent.some(Boolean) || !rowPresent.some(Boolean) || !colPresent.some(Boolean)) return;

        const layerRuns = computeAxisRuns(layerPresent);
        const rowRuns = computeAxisRuns(rowPresent);
        const colRuns = computeAxisRuns(colPresent);

        layerRuns.forEach(layerRun => {
            rowRuns.forEach(rowRun => {
                colRuns.forEach(colRun => {
                    const members = kmap3DState._cubes.filter(cube => {
                        if (cube.isLayerTag) return false;
                        return cube.l >= layerRun.lo && cube.l <= layerRun.hi &&
                               cube.r >= rowRun.lo && cube.r <= rowRun.hi &&
                               cube.c >= colRun.lo && cube.c <= colRun.hi;
                    });
                    if (members.length === 0) return;

                    // Layer axis is now laid out inverted (y = -axisPos(l, ...)),
                    // so a run touching layer index 0 (the top level) sits on the
                    // box's high-y side, and a run touching the last layer index
                    // sits on low-y. Rows now sit on the z (depth) axis instead.
                    pieces.push({
                        color,
                        members,
                        wrapFaces: {
                            xLow: colRun.wrapLow, xHigh: colRun.wrapHigh,
                            yLow: layerRun.wrapHigh, yHigh: layerRun.wrapLow,
                            zLow: rowRun.wrapLow, zHigh: rowRun.wrapHigh
                        }
                    });
                });
            });
        });
    });

    if (pieces.length === 0) return;

    // Pass 2: compute each piece's default (base-pad) box, then figure out
    // which pieces share a full face so the later one can be shrunk a touch.
    const boxOf = (piece, pad) => {
        const box = new THREE.Box3();
        piece.members.forEach(m => {
            const p = kmap3DState.exploded ? m.exploded : m.base;
            box.expandByPoint(new THREE.Vector3(p.x - pad, p.y - pad, p.z - pad));
            box.expandByPoint(new THREE.Vector3(p.x + pad, p.y + pad, p.z + pad));
        });
        return box;
    };
    const defaultBoxes = pieces.map(p => boxOf(p, basePad));
    const plainBoxes = defaultBoxes.map(b => ({
        minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z
    }));
    const extraShrink = computeAntiOverlapShrink3D(plainBoxes);

    // Pass 3: draw, shrinking the pad for any piece that needs separation.
    pieces.forEach((piece, i) => {
        const pad = Math.max(0.25, basePad - extraShrink[i]);
        const box = boxOf(piece, pad);
        const helper = _makeGroupBoxWireframe(box, piece.color, piece.wrapFaces);
        scene.add(helper);
        kmap3DState._groupHelpers.push(helper);
    });
}

function _updateKMap3DToolbarUI() {
    const explodeBtn = document.getElementById('kmap3d-explode-btn');
    if (explodeBtn) explodeBtn.classList.toggle('active', kmap3DState.exploded);
    const wireBtn = document.getElementById('kmap3d-wireframe-btn');
    if (wireBtn) wireBtn.classList.toggle('active', kmap3DState.wireframeOnly);
}

function _kmap3dIcon(name) {
    if (name === 'explode') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v5M12 16v5M4 12h5M15 12h5M6 6l3 3M18 6l-3 3M6 18l3-3M18 18l-3-3"/></svg>`;
    if (name === 'reset') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`;
    if (name === 'wireframe') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>`;
    return '';
}

function _wireKMap3DInteractions() {
    const ctx = kmap3DState._ctx;
    if (!ctx) return;

    const explodeBtn = document.getElementById('kmap3d-explode-btn');
    if (explodeBtn) explodeBtn.addEventListener('click', () => {
        kmap3DState.exploded = !kmap3DState.exploded;
        _updateKMap3DGroupHelpers();
        _updateKMap3DToolbarUI();
    });

    const wireBtn = document.getElementById('kmap3d-wireframe-btn');
    if (wireBtn) wireBtn.addEventListener('click', () => {
        kmap3DState.wireframeOnly = !kmap3DState.wireframeOnly;
        kmap3DState._cubes.forEach(cube => {
            if (cube.isLayerTag) return;
            // Wireframe-only mode now strips the gray cube boxes entirely —
            // it should read as just the state spheres plus the group loop
            // lines, not a wireframe of every cell.
            cube.mesh.visible = !kmap3DState.wireframeOnly;
            cube.edges.visible = false;
            cube.outline.visible = !kmap3DState.wireframeOnly;
        });
        _updateKMap3DToolbarUI();
    });

    const resetBtn = document.getElementById('kmap3d-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        kmap3DState.exploded = false;
        kmap3DState.wireframeOnly = false;
        kmap3DState._cubes.forEach(cube => {
            if (cube.isLayerTag) return;
            cube.mesh.visible = true;
            cube.edges.visible = false;
            cube.outline.visible = true;
        });
        const cw = canvasWrap.clientWidth || 600;
        const ch = canvasWrap.clientHeight || 380;
        kmap3DState._rot = { theta: 0.7, phi: 1.05, radius: _getKMap3DFitRadius(cw, ch) };
        kmap3DState._vel = { theta: 0, phi: 0 };
        _updateKMap3DGroupHelpers();
        _updateKMap3DCamera();
        _updateKMap3DToolbarUI();
    });

    const canvasWrap = document.getElementById('kmap-3d-canvas-wrap');
    const renderer = kmap3DState._renderer;
    if (!canvasWrap || !renderer) return;
    const dom = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    let _dragLastT = 0;

    const onDown = (clientX, clientY) => {
        kmap3DState._drag.active = true;
        kmap3DState._drag.moved = false;
        kmap3DState._drag.startX = clientX;
        kmap3DState._drag.startY = clientY;
        kmap3DState._drag.lastX = clientX;
        kmap3DState._drag.lastY = clientY;
        kmap3DState._vel.theta = 0;
        kmap3DState._vel.phi = 0;
        _dragLastT = performance.now();
        dom.style.cursor = 'grabbing';
    };
    const onMove = (clientX, clientY) => {
        if (!kmap3DState._drag.active) return;
        const dx = clientX - kmap3DState._drag.lastX;
        const dy = clientY - kmap3DState._drag.lastY;
        // Classify drag-vs-tap by TOTAL displacement from the original press
        // point, not a single inter-sample delta. The old "> 6px between
        // this touchmove and the last one" check meant one noisy digitizer
        // sample (a touch's reported (x,y) can jitter several px between
        // samples even while the finger is physically still - more common
        // on touchscreens than with a mouse) was enough to flip `moved` to
        // true, which then made onUp() below skip its raycast/toggle
        // entirely - a stationary tap read as a drag and silently did
        // nothing. Requiring 10px of *cumulative* movement from the actual
        // start point is far more resistant to that per-sample noise while
        // still recognizing a real drag almost immediately.
        const totalDist = Math.hypot(clientX - kmap3DState._drag.startX, clientY - kmap3DState._drag.startY);
        if (totalDist > 10) kmap3DState._drag.moved = true;
        kmap3DState._rot.theta -= dx * 0.008;
        kmap3DState._rot.phi = Math.min(Math.max(kmap3DState._rot.phi - dy * 0.008, 0.25), Math.PI - 0.25);
        kmap3DState._drag.lastX = clientX;
        kmap3DState._drag.lastY = clientY;

        // Estimate instantaneous angular velocity (normalized to a ~60fps
        // step) and blend it into the running velocity so release picks up
        // the most recent flick speed, smoothed against event-rate jitter.
        const now = performance.now();
        const dt = Math.min(Math.max(now - _dragLastT, 1), 100);
        _dragLastT = now;
        const instTheta = (dx * 0.008) * (16.6 / dt);
        const instPhi   = (dy * 0.008) * (16.6 / dt);
        kmap3DState._vel.theta = kmap3DState._vel.theta * 0.5 + instTheta * 0.5;
        kmap3DState._vel.phi   = kmap3DState._vel.phi   * 0.5 + instPhi   * 0.5;

        _updateKMap3DCamera();
    };
    const onUp = (clientX, clientY) => {
        if (kmap3DState._drag.active && !kmap3DState._drag.moved) {
            const rect = dom.getBoundingClientRect();
            mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, kmap3DState._camera);
            const meshes = kmap3DState._cubes.filter(c => !c.isLayerTag).map(c => c.mesh);
            const hits = raycaster.intersectObjects(meshes, false);
            if (hits.length > 0) {
                handleKMapCellClick(hits[0].object.userData.minterm);
            }
        }
        kmap3DState._drag.active = false;
        dom.style.cursor = 'grab';
    };
    dom.style.cursor = 'grab';

    // Mouse controls (desktop)
    dom.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));

    // Remove any listeners from a previous wiring pass before attaching new
    // ones — _wireKMap3DInteractions() runs again after every re-render
    // (e.g. every single cell toggle), so without this, stale window
    // listeners referencing the old/detached canvas accumulated forever,
    // each one re-applying the same drag delta and making rotation get
    // progressively more erratic the longer a session went on.
    if (kmap3DState._windowMoveHandler) window.removeEventListener('mousemove', kmap3DState._windowMoveHandler);
    if (kmap3DState._windowUpHandler) window.removeEventListener('mouseup', kmap3DState._windowUpHandler);
    kmap3DState._windowMoveHandler = (e) => onMove(e.clientX, e.clientY);
    kmap3DState._windowUpHandler = (e) => onUp(e.clientX, e.clientY);
    window.addEventListener('mousemove', kmap3DState._windowMoveHandler);
    window.addEventListener('mouseup', kmap3DState._windowUpHandler);

    dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        kmap3DState._rot.radius = Math.min(Math.max(kmap3DState._rot.radius + e.deltaY * 0.01, 4), 50);
        _updateKMap3DCamera();
    }, { passive: false });

    // Touch controls (mobile): one finger drags/rotates & taps to select,
    // two fingers pinch to zoom (mirrors the mouse-drag + wheel-zoom above).
    let _kmap3dPinchDist = 0;
    dom.style.touchAction = 'none';
    dom.addEventListener('touchstart', (e) => {
        // preventDefault here (touch-action is already 'none', so this
        // costs no scroll/pan behavior) stops the browser from firing a
        // delayed "ghost" mousedown/mousemove/mouseup/click at the tap
        // position afterward. Without it, tapping a cell to toggle it also
        // triggered the desktop mouse-drag path a moment later, which read
        // as the view suddenly rotating/resetting right after the tap.
        e.preventDefault();
        if (e.touches.length === 1) {
            onDown(e.touches[0].clientX, e.touches[0].clientY);
        } else if (e.touches.length === 2) {
            kmap3DState._drag.active = false;
            kmap3DState._vel.theta = 0;
            kmap3DState._vel.phi = 0;
            const [t1, t2] = e.touches;
            _kmap3dPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        }
    }, { passive: false });

    dom.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && kmap3DState._drag.active) {
            e.preventDefault();
            onMove(e.touches[0].clientX, e.touches[0].clientY);
        } else if (e.touches.length === 2) {
            e.preventDefault();
            const [t1, t2] = e.touches;
            const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            if (_kmap3dPinchDist > 0) {
                const delta = dist - _kmap3dPinchDist;
                kmap3DState._rot.radius = Math.min(Math.max(kmap3DState._rot.radius - delta * 0.03, 4), 50);
                _updateKMap3DCamera();
            }
            _kmap3dPinchDist = dist;
        }
    }, { passive: false });

    const _kmap3dTouchEnd = (e) => {
        if (e.cancelable) e.preventDefault();
        const lastTouch = e.changedTouches && e.changedTouches[0];
        onUp(lastTouch ? lastTouch.clientX : kmap3DState._drag.lastX, lastTouch ? lastTouch.clientY : kmap3DState._drag.lastY);
        _kmap3dPinchDist = 0;
    };
    dom.addEventListener('touchend', _kmap3dTouchEnd, { passive: false });
    dom.addEventListener('touchcancel', _kmap3dTouchEnd, { passive: false });

    kmap3DState._resizeHandler = () => {
        const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
        if (!w || !h || !kmap3DState._renderer) return;
        kmap3DState._camera.aspect = w / h;
        kmap3DState._camera.updateProjectionMatrix();
        kmap3DState._renderer.setSize(w, h);
        
        // Push the camera back if rotating the device caused it to clip
        const minFit = _getKMap3DFitRadius(w, h);
        if (kmap3DState._rot.radius < minFit) {
            kmap3DState._rot.radius = minFit;
            _updateKMap3DCamera();
        }
    };
    window.addEventListener('resize', kmap3DState._resizeHandler);
}

function _updateKMap3DCamera() {
    const camera = kmap3DState._camera;
    if (!camera) return;
    const { theta, phi, radius } = kmap3DState._rot;
    camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, 0, 0);
}

function _kmap3DAnimate() {
    const cubes = kmap3DState._cubes;
    const renderer = kmap3DState._renderer;
    const scene = kmap3DState._scene;
    const camera = kmap3DState._camera;
    if (!renderer || !scene || !camera) return;

    // Free-wheel inertia: once the user lets go, keep spinning at the
    // last-recorded flick velocity and decay it (friction) each frame
    // until it settles back to a stop.
    if (!kmap3DState._drag.active) {
        const vel = kmap3DState._vel;
        if (Math.abs(vel.theta) > 0.00008 || Math.abs(vel.phi) > 0.00008) {
            kmap3DState._rot.theta -= vel.theta;
            kmap3DState._rot.phi = Math.min(Math.max(kmap3DState._rot.phi - vel.phi, 0.25), Math.PI - 0.25);
            vel.theta *= 0.945;
            vel.phi *= 0.945;
            _updateKMap3DCamera();
        } else {
            vel.theta = 0;
            vel.phi = 0;
        }
    }

    let stillMoving = false;
    cubes.forEach(cube => {
        const target = kmap3DState.exploded ? cube.exploded : cube.base;
        const p = (cube.holder || cube.mesh).position;
        const dx = target.x - p.x, dy = target.y - p.y, dz = target.z - p.z;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0.002) {
            p.x += dx * 0.15; p.y += dy * 0.15; p.z += dz * 0.15;
            stillMoving = true;
        } else {
            p.set(target.x, target.y, target.z);
        }
    });

    renderer.render(scene, camera);
    kmap3DState._raf = requestAnimationFrame(_kmap3DAnimate);
}

let kmapWrapInitialized = false;
let wrapDragState = { isDragging: false, startX: 0, startY: 0, offX: 0, offY: 0, hasMoved: false };

function renderWrapKMap(numVars, variables, minterms, dontCares, activeSolution, isSOP) {
    const container2D = document.getElementById('kmap-grid-container');
    const svgOverlay = document.getElementById('kmap-svg-overlay');
    const wrapper3d = document.getElementById('kmap-3d-container');
    const wrapContainer = document.getElementById('kmap-wrap-container');
    const wrapSurface = document.getElementById('kmap-wrap-surface');
    const wrapSvg = document.getElementById('kmap-wrap-svg-overlay');
    const wrapper = document.getElementById('kmap-visual-wrapper');
    
    if (container2D) container2D.style.display = 'none';
    if (svgOverlay) svgOverlay.style.display = 'none';
    if (wrapper3d) wrapper3d.style.display = 'none';
    if (!wrapContainer) return;
    
    wrapContainer.style.display = 'block';

    let rowsBits = 1;
    let colsBits = 1;
    if (numVars === 3) { rowsBits = 1; colsBits = 2; }
    if (numVars === 4) { rowsBits = 2; colsBits = 2; }
    if (numVars === 2) { rowsBits = 1; colsBits = 1; }

    const rowVars = variables.slice(0, rowsBits);
    const colVars = variables.slice(rowsBits);
    
    const rowGray = getGrayCodeStr(rowsBits);
    const colGray = getGrayCodeStr(colsBits);
    
    // Tiled cells (NO headers to avoid duplicate header glitch)
    let singleTileHtml = '<table style="border-collapse: collapse; margin: 0; padding: 0;">';
    for (let r = 0; r < rowGray.length; r++) {
        singleTileHtml += `<tr>`;
        for (let c = 0; c < colGray.length; c++) {
            const binaryStr = rowGray[r] + colGray[c];
            const minterm = parseInt(binaryStr, 2);
            let val = '0';
            if (minterms.includes(minterm)) val = '1';
            if (dontCares.includes(minterm)) val = 'X';
            singleTileHtml += `<td class="kmap-cell val-${val}" data-minterm="${minterm}" onclick="handleKMapCellClick(${minterm})" style="width: ${WRAP_CELL_SIZE}px; height: ${WRAP_CELL_SIZE}px; min-width: ${WRAP_CELL_SIZE}px; min-height: ${WRAP_CELL_SIZE}px; border: 1px solid var(--border); box-sizing: border-box; text-align: center; vertical-align: middle; position: relative; font-size: ${Math.round(WRAP_CELL_SIZE * 0.4)}px;">`;
            singleTileHtml += `<div class="kmap-minterm-label">${minterm}</div>`;
            singleTileHtml += `${val}</td>`;
        }
        singleTileHtml += '</tr>';
    }
    singleTileHtml += '</table>';
    
    // Calculate required tiles to cover the screen
    const cellSize = WRAP_CELL_SIZE;
    const w = colGray.length * cellSize;
    const h = rowGray.length * cellSize;
    
    const availW = wrapper.clientWidth;
    const availH = wrapper.clientHeight;
    
    const tilesX = Math.ceil(availW / w) + 2;
    const tilesY = Math.ceil(availH / h) + 2;
    
    let surfaceHtml = `<div style="display: grid; grid-template-columns: repeat(${tilesX}, max-content); grid-template-rows: repeat(${tilesY}, max-content); place-items: center; gap: 0;">`;
    for(let i=0; i< (tilesX * tilesY); i++) {
        surfaceHtml += `<div id="wrap-tile-${i}" style="margin:0; padding:0;">${singleTileHtml}</div>`;
    }
    surfaceHtml += '</div>';
    
    // Floating Headers with SVG line split (50x50 corner)
    let headerHtml = `<div id="wrap-corner" class="kmap-corner" style="position: absolute; top:0; left:0; width:40px; height:40px; background:var(--bg-primary); z-index: 30; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); box-sizing: border-box; padding: 0;">`;
    headerHtml += `<svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="100%" stroke="var(--border)" stroke-width="1.5" /></svg>`;
    headerHtml += `<div class="kmap-corner-col">${colVars.join('')}</div>`;
    headerHtml += `<div class="kmap-corner-row">${rowVars.join('')}</div>`;
    headerHtml += `</div>`;

    headerHtml += `<div id="wrap-top-header" style="position: absolute; top:0; left: 40px; display: flex; z-index: 20; background:var(--bg-primary); height:40px; border-bottom: 1px solid var(--border);">`;
    for(let i=0; i<tilesX; i++) {
        for(let c of colGray) headerHtml += `<div style="width: ${WRAP_CELL_SIZE}px; height: 50px; display:flex; align-items:center; justify-content:center; font-weight:normal; font-size: 0.95em; color:var(--text-secondary); box-sizing: border-box; vertical-align: bottom; padding-bottom: 2px;">${c}</div>`;
    }
    headerHtml += `</div>`;
    
    headerHtml += `<div id="wrap-left-header" style="position: absolute; top: 50px; left: 0; display: flex; flex-direction: column; z-index: 20; background:var(--bg-primary); width:50px; border-right: 1px solid var(--border);">`;
    for(let i=0; i<tilesY; i++) {
        for(let r of rowGray) headerHtml += `<div style="width: 50px; height: ${WRAP_CELL_SIZE}px; display:flex; align-items:center; justify-content:center; font-weight:normal; font-size: 0.95em; color:var(--text-secondary); box-sizing: border-box; text-align: right; padding-right: 4px;">${r}</div>`;
    }
    headerHtml += `</div>`;

    wrapSurface.innerHTML = headerHtml + surfaceHtml;

    const updateTransform = () => {
        let tx = wrapDragState.offX % w;
        if (tx > 0) tx -= w;
        let ty = wrapDragState.offY % h;
        if (ty > 0) ty -= h;
        
        const gridEl = wrapSurface.children[3]; // corner (0), top (1), left (2), grid (3)
        gridEl.style.transform = `translate(${tx - w + 50}px, ${ty - h + 50}px)`;
        
        wrapSvg.style.transform = `translate(${tx - w + 50}px, ${ty - h + 50}px)`;
        
        const topHeader = document.getElementById('wrap-top-header');
        if(topHeader) topHeader.style.transform = `translateX(${tx - w}px)`;
        
        const leftHeader = document.getElementById('wrap-left-header');
        if(leftHeader) leftHeader.style.transform = `translateY(${ty - h}px)`;
    };

    if (!kmapWrapInitialized) {
        kmapWrapInitialized = true;
        
        wrapContainer.addEventListener('mousedown', (e) => {
            wrapDragState.isDragging = true;
            wrapDragState.startX = e.clientX;
            wrapDragState.startY = e.clientY;
            wrapDragState.hasMoved = false;
            wrapContainer.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', (e) => {
            if (!wrapDragState.isDragging) return;
            const dx = e.clientX - wrapDragState.startX;
            const dy = e.clientY - wrapDragState.startY;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                wrapDragState.hasMoved = true;
            }
            wrapDragState.offX += dx;
            wrapDragState.offY += dy;
            wrapDragState.startX = e.clientX;
            wrapDragState.startY = e.clientY;
            updateTransform();
        });
        window.addEventListener('mouseup', () => {
            wrapDragState.isDragging = false;
            wrapContainer.style.cursor = 'grab';
        });
        window.addEventListener('mouseleave', () => {
            wrapDragState.isDragging = false;
            wrapContainer.style.cursor = 'grab';
        });

        // Touch event listeners for mobile panning
        wrapContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                wrapDragState.isDragging = true;
                wrapDragState.startX = e.touches[0].clientX;
                wrapDragState.startY = e.touches[0].clientY;
                wrapDragState.hasMoved = false;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (wrapDragState.isDragging && e.touches.length === 1) {
                e.preventDefault();
                const dx = e.touches[0].clientX - wrapDragState.startX;
                const dy = e.touches[0].clientY - wrapDragState.startY;
                if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                    wrapDragState.hasMoved = true;
                }
                wrapDragState.offX += dx;
                wrapDragState.offY += dy;
                wrapDragState.startX = e.touches[0].clientX;
                wrapDragState.startY = e.touches[0].clientY;
                updateTransform();
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            wrapDragState.isDragging = false;
        });
        
        window.addEventListener('touchcancel', () => {
            wrapDragState.isDragging = false;
        });
    }
    
    updateTransform();
    requestAnimationFrame(() => {
        drawWrapSVGLoops(activeSolution, numVars, rowsBits, colsBits, rowGray, colGray, tilesX, tilesY);
    });
}

// Given the sorted list of Gray-code indices (in [0,len)) that a term
// matches along one axis, finds the single contiguous *cyclic* run they
// form. A valid power-of-two K-map group's matches are always exactly one
// cyclic run - but that run can wrap past the end of the axis (e.g. rows
// {3,0} in a 4-row axis are adjacent because index 3 is next to index 0
// cyclically). Returns { start, count } where start is always in [0,len)
// but start+count may exceed len - callers should NOT wrap that back into
// range: drawing the overflow past the tile's edge is exactly what makes it
// align seamlessly with the next tile in the infinite wrap view.
function findCyclicRun(matches, len) {
    if (matches.length >= len) return { start: 0, count: len };
    const set = new Set(matches);
    for (const m of matches) {
        const prev = (m - 1 + len) % len;
        if (!set.has(prev)) {
            return { start: m, count: matches.length };
        }
    }
    // Shouldn't happen for a valid K-map group, but fail safe.
    return { start: matches[0], count: matches.length };
}

function drawWrapSVGLoops(solution, numVars, rowsBits, colsBits, rowGray, colGray, tilesX, tilesY) {
    const wrapSvg = document.getElementById('kmap-wrap-svg-overlay');
    const wrapSurface = document.getElementById('kmap-wrap-surface');
    if (!wrapSvg || !wrapSurface) return;
    
    wrapSvg.innerHTML = '';
    const gridEl = wrapSurface.children[3];
    wrapSvg.setAttribute('width', gridEl.scrollWidth);
    wrapSvg.setAttribute('height', gridEl.scrollHeight);
    
    const surfaceRect = gridEl.getBoundingClientRect();
    
    // Use the same palette as every other K-map view (normal 2D, 3D) so a
    // given group reads as the same color no matter which view mode it's
    // seen in.
    const colors = LOOP_COLORS;

    const cellSize = WRAP_CELL_SIZE;

    // The 5px pad / 12px corner-radius / 3px stroke-width used below were
    // tuned for the normal (non-wrap) K-map view's un-scaled 80px cell (see
    // drawLoopPieceSVG). The wrap view's cell is a fixed 44px, so applying
    // those same absolute pixel values here makes the outline read as
    // oversized and over-rounded relative to the smaller cell. Scale them
    // down by the same ratio, the same way drawLoopPieceSVG scales by the
    // normal view's container-fit `scale`.
    const wrapLoopScale = cellSize / 80;

    for (let i = 0; i < (tilesX * tilesY); i++) {
        const tile = document.getElementById(`wrap-tile-${i}`);
        if (!tile) continue;

        // Tile origin in surface coordinates. Position within the tile is
        // computed algebraically from here (start * cellSize) rather than by
        // querying a specific <td>, since a wrapped group's run can extend
        // past this tile's own row/col count into the next tile.
        const tileRect = tile.getBoundingClientRect();
        const tileOriginX = tileRect.left - surfaceRect.left;
        const tileOriginY = tileRect.top - surfaceRect.top;

        // Pass 1: compute every group's raw (un-padded) box within this tile.
        const rects = solution.map(termStr => {
            const term = termStr;

            // As in drawSVGLoops: a selection filters which term gets a box
            // (returning null here, same as a term that doesn't touch this
            // tile), without touching the idx-based color below.
            if (_selectedImplicantTerm !== null && termStr !== _selectedImplicantTerm) return null;

            const rMatches = [];
            for (let r = 0; r < rowGray.length; r++) {
                let match = true;
                for(let k=0; k<rowsBits; k++) {
                    if (term[k] !== '-' && term[k] !== rowGray[r][k]) { match = false; break; }
                }
                if (match) rMatches.push(r);
            }
            const cMatches = [];
            for (let c = 0; c < colGray.length; c++) {
                let match = true;
                for(let k=0; k<colsBits; k++) {
                    if (term[rowsBits + k] !== '-' && term[rowsBits + k] !== colGray[c][k]) { match = false; break; }
                }
                if (match) cMatches.push(c);
            }

            if (rMatches.length === 0 || cMatches.length === 0) return null;

            // Groups whose matching rows/cols aren't a simple forward range
            // (e.g. row 0 and row 3 of a 4-row axis) wrap cyclically - find
            // where that run actually starts so the box lands in the right
            // place, including spilling into the neighboring tile when it
            // wraps past this tile's edge.
            const { start: rStart, count: rCount } = findCyclicRun(rMatches, rowGray.length);
            const { start: cStart, count: cCount } = findCyclicRun(cMatches, colGray.length);

            const minX = tileOriginX + cStart * cellSize;
            const minY = tileOriginY + rStart * cellSize;
            return { minX, minY, maxX: minX + cCount * cellSize, maxY: minY + rCount * cellSize };
        });

        // Pass 2: figure out which groups (within this tile) share an overlapping edge.
        const extraShrink = computeAntiOverlapShrink(rects);

        // Pass 3: draw, using the base pad plus any anti-overlap shrink, both
        // scaled down to match this view's smaller fixed cell size.
        rects.forEach((r, idx) => {
            if (!r) return;
            const color = colors[idx % colors.length];
            const pad = (5 + extraShrink[idx]) * wrapLoopScale;
            const w = Math.max(2, (r.maxX - r.minX) - pad * 2);
            const h = Math.max(2, (r.maxY - r.minY) - pad * 2);
            const rx = Math.min(12 * wrapLoopScale, w / 2, h / 2);
            const strokeWidth = Math.max(1, 3 * wrapLoopScale);

            const path = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            path.setAttribute("x", r.minX + pad);
            path.setAttribute("y", r.minY + pad);
            path.setAttribute("width", w);
            path.setAttribute("height", h);
            path.setAttribute("fill", color);
            path.setAttribute("fill-opacity", "0.2");
            path.setAttribute("stroke", color);
            path.setAttribute("stroke-width", String(strokeWidth));
            path.setAttribute("rx", String(rx));
            wrapSvg.appendChild(path);
        });
    }
}

// renderAlgebraicSolution removed and merged into renderSolutionView


