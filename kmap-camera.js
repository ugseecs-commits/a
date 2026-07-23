/**
 * K-Map Camera Module for Mantiq
 * Sudoku-scanner-style flow: live detect -> hold-steady lock -> freeze ->
 * confidence-scored OCR -> tap-to-correct review grid -> proceed.
 * Always has a manual-entry escape hatch, so it can never dead-end.
 */

(function() {
    // ---- DOM refs ----
    let video = document.getElementById('kmap-video');
    let overlay = document.getElementById('kmap-overlay-canvas');
    let statusMsg = document.getElementById('kmap-status-msg');
    let proceedBtn = document.getElementById('kmap-proceed-btn');
    let popup = document.getElementById('kmap-camera-popup');
    let sizeRow = document.getElementById('kmap-size-row');
    let manualBtn = document.getElementById('kmap-manual-entry-btn');
    let torchBtn = document.getElementById('kmap-torch-btn');
    let reviewContainer = document.getElementById('kmap-review-container');
    let reviewImage = document.getElementById('kmap-review-image');
    let reviewGrid = document.getElementById('kmap-review-grid');
    let rescanBtn = document.getElementById('kmap-rescan-btn');
    let progressBar = document.getElementById('kmap-progress-fill');

    // ---- State ----
    let stream = null;
    let track = null;
    let torchOn = false;
    let state = 'idle'; // idle | scanning | processing | review
    let tesseractWorker = null;

    let manualSizeOverride = { rows: 4, cols: 4 }; // always set now — matches the preselected "4 Var" button
    let stabilityHistory = [];     // recent {rows, cols, cx, cy, w} for lock detection
    let lastLockedTime = 0;        // timestamp of the last frame where a valid grid was found
    const STABILITY_FRAMES = 7;
    const STABILITY_POS_TOL_RATIO = 0.05; // allowed centroid jitter, as a fraction of grid width
    const STABILITY_POS_TOL_MIN = 22;     // px floor, so small/far-away grids aren't overly strict
    const MISS_GRACE_MS = 2000;    // grace period (ms) before a lost detection resets progress

    let reviewRows = 0, reviewCols = 0;
    let reviewValues = [];  // { val: '0'|'1'|'X'|'', auto: bool, lowConf: bool }
    const CYCLE = ['', '1', '0', 'X'];

    const TARGET_WARP_SIZE = 400;

    // ============================================================
    // Entry / exit
    // ============================================================

    document.getElementById('kmap-camera-btn').addEventListener('click', async () => {
        popup.style.display = 'block';
        resetToScanning();
        statusMsg.innerText = 'Initializing camera & OCR...';

        if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('eng');
            await tesseractWorker.setParameters({
                tessedit_char_whitelist: '01xXdD',
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR
            });
        }

        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            video.srcObject = stream;
            video.play();
            track = stream.getVideoTracks()[0];
            setupTorchButton();

            video.onloadedmetadata = () => {
                video.width = video.videoWidth;
                video.height = video.videoHeight;
                overlay.width = video.videoWidth;
                overlay.height = video.videoHeight;

                if (typeof cv !== 'undefined' && cv.Mat) {
                    beginScanning();
                } else {
                    let waitCv = setInterval(() => {
                        if (typeof cv !== 'undefined' && cv.Mat) {
                            clearInterval(waitCv);
                            beginScanning();
                        }
                    }, 400);
                }
            };
        } catch (err) {
            statusMsg.innerText = 'Camera access denied or unavailable. Tap "Enter Manually" below.';
            console.error(err);
        }
    });

    document.getElementById('kmap-camera-close').addEventListener('click', () => {
        stopCamera();
        popup.style.display = 'none';
    });

    function stopCamera() {
        state = 'idle';
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
            track = null;
        }
    }

    function beginScanning() {
        stabilityHistory = [];
        lastLockedTime = 0;
        state = 'scanning';
        statusMsg.innerText = 'Point camera at a K-Map...';
        setProgress(0);
        requestAnimationFrame(renderLoop);
    }

    function resetToScanning() {
        reviewContainer.style.display = 'none';
        overlay.style.display = 'block';
        video.style.display = 'block';
        sizeRow.style.display = 'flex';
        proceedBtn.style.display = 'none';
        rescanBtn.style.display = 'none';
        stabilityHistory = [];
        lastLockedTime = 0;
        setProgress(0);
        if (video.srcObject) {
            state = 'scanning';
            requestAnimationFrame(renderLoop);
        }
    }

    // ============================================================
    // Grid size preset buttons (manual override for detection)
    // ============================================================

    sizeRow.querySelectorAll('.kmap-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sizeRow.querySelectorAll('.kmap-size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const preset = btn.getAttribute('data-size');
            const [r, c] = preset.split('x').map(Number);
            manualSizeOverride = { rows: r, cols: c };
            stabilityHistory = [];
            lastLockedTime = 0;
            setProgress(0);
        });
    });

    // ============================================================
    // Torch (flashlight)
    // ============================================================

    function setupTorchButton() {
        torchBtn.style.display = 'none';
        try {
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.torch) {
                torchBtn.style.display = 'inline-flex';
            }
        } catch (e) { /* not supported, leave hidden */ }
    }

    torchBtn.addEventListener('click', async () => {
        if (!track) return;
        torchOn = !torchOn;
        try {
            await track.applyConstraints({ advanced: [{ torch: torchOn }] });
            torchBtn.classList.toggle('active', torchOn);
        } catch (e) {
            torchOn = !torchOn; // revert
        }
    });

    // ============================================================
    // Manual entry fallback (no camera / OCR needed at all)
    // ============================================================

    manualBtn.addEventListener('click', () => {
        state = 'review';
        const preset = manualSizeOverride || { rows: 4, cols: 4 };
        reviewRows = preset.rows;
        reviewCols = preset.cols;
        reviewValues = new Array(reviewRows * reviewCols).fill(null).map(() => ({ val: '', auto: false, lowConf: false }));
        showReview(null); // no background image, blank grid
        statusMsg.innerText = 'Manual entry — tap cells to set 0 / 1 / X.';
    });

    // ============================================================
    // Live detection loop
    // ============================================================

    function renderLoop() {
        if (state !== 'scanning') return;

        let cap = new cv.VideoCapture(video);
        let src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
        try {
            cap.read(src);
        } catch (e) {
            src.delete();
            requestAnimationFrame(renderLoop);
            return;
        }

        let gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

        let blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

        let thresh = new cv.Mat();
        cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);

        let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);

        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(thresh, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        let bestQuad = null;
        let bestGridParams = null;

        let contourList = [];
        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let hull = new cv.Mat();
            cv.convexHull(cnt, hull, false, true);
            let area = cv.contourArea(hull);

            if (area > 10000) {
                let peri = cv.arcLength(hull, true);
                let approx = new cv.Mat();
                cv.approxPolyDP(hull, approx, 0.05 * peri, true);
                if (approx.rows === 4) {
                    contourList.push({ area, approx: approx.clone() });
                }
                approx.delete();
            }
            hull.delete();
        }

        contourList.sort((a, b) => b.area - a.area);

        for (let i = 0; i < contourList.length; i++) {
            let approx = contourList[i].approx;
            let validAngles = true;
            for (let j = 0; j < 4; j++) {
                let p1 = { x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] };
                let p2 = { x: approx.data32S[((j + 1) % 4) * 2], y: approx.data32S[((j + 1) % 4) * 2 + 1] };
                let p3 = { x: approx.data32S[((j + 2) % 4) * 2], y: approx.data32S[((j + 2) % 4) * 2 + 1] };

                let v1 = { x: p1.x - p2.x, y: p1.y - p2.y };
                let v2 = { x: p3.x - p2.x, y: p3.y - p2.y };

                let dot = v1.x * v2.x + v1.y * v2.y;
                let mag1 = Math.hypot(v1.x, v1.y);
                let mag2 = Math.hypot(v2.x, v2.y);
                let angle = Math.acos(dot / (mag1 * mag2)) * 180 / Math.PI;

                if (angle < 60 || angle > 120) { validAngles = false; break; }
            }

            if (validAngles) {
                let pts = [];
                for (let k = 0; k < 4; k++) pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
                pts.sort((a, b) => a.y - b.y);
                let top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
                let bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
                let sortedPts = [top[0], top[1], bottom[1], bottom[0]];

                let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                    sortedPts[0].x, sortedPts[0].y, sortedPts[1].x, sortedPts[1].y,
                    sortedPts[3].x, sortedPts[3].y, sortedPts[2].x, sortedPts[2].y
                ]);
                let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                    0, 0, TARGET_WARP_SIZE, 0, 0, TARGET_WARP_SIZE, TARGET_WARP_SIZE, TARGET_WARP_SIZE
                ]);
                let M = cv.getPerspectiveTransform(srcTri, dstTri);
                let warped = new cv.Mat();
                cv.warpPerspective(thresh, warped, M, new cv.Size(TARGET_WARP_SIZE, TARGET_WARP_SIZE));

                let { hPos, vPos } = detectGridLines(warped);
                // Since the person always tells us which grid size to expect
                // now (2/3/4 Var — no more Auto), don't just trust any
                // 4-cornered shape. Require the detected internal lines to
                // actually match that size. If a header/label outside the
                // real grid got swept into the outer contour, the line count
                // here won't line up with the expected size and this
                // candidate gets rejected outright rather than accepted and
                // cropped wrong.
                let gridCheck = validateExpectedGrid(manualSizeOverride, hPos, vPos);
                if (gridCheck) {
                    // The outer contour is only a rough locator — it commonly
                    // overshoots into header text/labels above or beside the
                    // grid. Re-derive the true corners from the detected grid
                    // LINES (text is erased by the line-isolation morphology),
                    // so cell math lines up with the real borders.
                    let refinedPts = refineCorners(sortedPts, hPos, vPos, TARGET_WARP_SIZE);
                    bestQuad = approx.clone();
                    bestGridParams = { pts: refinedPts, rows: gridCheck.rows, cols: gridCheck.cols };
                    srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
                    break;
                }

                srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
            }
        }
        for (let i = 0; i < contourList.length; i++) contourList[i].approx.delete();

        let ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (bestQuad && bestGridParams) {
            lastLockedTime = performance.now();
            drawOverlay(ctx, bestGridParams);
            trackStability(bestGridParams);
            bestQuad.delete();
        } else {
            // A dropped frame or two — motion blur, brief glare, the camera
            // wobbling as a hand moves — shouldn't throw away progress
            // that's nearly locked. Only reset once the grid has genuinely
            // been unreadable for a real stretch of time, not just a few
            // frames (frame timing varies a lot under load, so a small
            // frame counter got exhausted almost instantly during motion).
            let sinceLock = performance.now() - lastLockedTime;
            if (stabilityHistory.length === 0 || sinceLock > MISS_GRACE_MS) {
                stabilityHistory = [];
                setProgress(0);
                statusMsg.innerText = manualSizeOverride
                    ? `Looking for a ${manualSizeOverride.rows}x${manualSizeOverride.cols} grid...`
                    : 'Looking for a K-Map grid...';
            }
        }

        contours.delete(); hierarchy.delete(); kernel.delete();
        thresh.delete(); blurred.delete(); gray.delete();

        if (state === 'scanning') {
            requestAnimationFrame(renderLoop);
        }
        src.delete();
    }

    function drawOverlay(ctx, gridParams) {
        let sortedPts = gridParams.pts, rows = gridParams.rows, cols = gridParams.cols;
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sortedPts[0].x, sortedPts[0].y);
        ctx.lineTo(sortedPts[1].x, sortedPts[1].y);
        ctx.lineTo(sortedPts[2].x, sortedPts[2].y);
        ctx.lineTo(sortedPts[3].x, sortedPts[3].y);
        ctx.closePath();
        ctx.stroke();

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.5)';
        for (let r = 1; r < rows; r++) {
            let ratio = r / rows;
            let p1 = { x: sortedPts[0].x + (sortedPts[3].x - sortedPts[0].x) * ratio, y: sortedPts[0].y + (sortedPts[3].y - sortedPts[0].y) * ratio };
            let p2 = { x: sortedPts[1].x + (sortedPts[2].x - sortedPts[1].x) * ratio, y: sortedPts[1].y + (sortedPts[2].y - sortedPts[1].y) * ratio };
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        }
        for (let c = 1; c < cols; c++) {
            let ratio = c / cols;
            let p1 = { x: sortedPts[0].x + (sortedPts[1].x - sortedPts[0].x) * ratio, y: sortedPts[0].y + (sortedPts[1].y - sortedPts[0].y) * ratio };
            let p2 = { x: sortedPts[3].x + (sortedPts[2].x - sortedPts[3].x) * ratio, y: sortedPts[3].y + (sortedPts[2].y - sortedPts[3].y) * ratio };
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        }
    }

    // ---- Hold-steady lock: require several consecutive consistent frames ----
    function trackStability(gridParams) {
        let pts = gridParams.pts;
        let cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
        let cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
        let w = distance(pts[0], pts[1]);

        stabilityHistory.push({ rows: gridParams.rows, cols: gridParams.cols, cx, cy, w });
        if (stabilityHistory.length > STABILITY_FRAMES) stabilityHistory.shift();

        let ok = stabilityHistory.length === STABILITY_FRAMES;
        if (ok) {
            const first = stabilityHistory[0];
            const posTol = Math.max(STABILITY_POS_TOL_MIN, first.w * STABILITY_POS_TOL_RATIO);
            for (const h of stabilityHistory) {
                if (h.rows !== first.rows || h.cols !== first.cols) { ok = false; break; }
                if (Math.hypot(h.cx - first.cx, h.cy - first.cy) > posTol) { ok = false; break; }
                if (Math.abs(h.w - first.w) > first.w * 0.2) { ok = false; break; }
            }
        }

        setProgress(stabilityHistory.length / STABILITY_FRAMES);
        statusMsg.innerText = `Found ${gridParams.rows}x${gridParams.cols} grid — hold steady...`;

        if (ok) {
            state = 'processing';
            setProgress(1);
            statusMsg.innerText = 'Got it! Reading values...';
            lockAndAnalyze(gridParams);
        }
    }

    function distance(p1, p2) {
        return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    function setProgress(frac) {
        if (progressBar) progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    }

    // Isolates only long, solid grid lines (morph-open erases thin text/noise
    // shorter than ~size/8 px) and returns the x-positions of vertical lines
    // (hPos) and y-positions of horizontal lines (vPos) inside the warp.
    function detectGridLines(warpedThresh) {
        let size = TARGET_WARP_SIZE;

        function getIntersections(isRow, pos, matToScan) {
            let positions = [];
            let inLine = false;
            let lineStart = 0;
            let ptr = isRow ? matToScan.ucharPtr(pos) : null;

            for (let i = 0; i < size; i++) {
                let val = isRow ? ptr[i] : matToScan.ucharPtr(i, pos)[0];
                if (val > 128) {
                    if (!inLine) { inLine = true; lineStart = i; }
                } else {
                    if (inLine) {
                        positions.push((lineStart + i) / 2);
                        inLine = false;
                    }
                }
            }
            if (inLine) positions.push((lineStart + size) / 2);
            return positions;
        }

        let kernelSize = Math.floor(size / 8);
        let hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, 1));
        let hLines = new cv.Mat();
        cv.morphologyEx(warpedThresh, hLines, cv.MORPH_OPEN, hKernel);

        let vKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, kernelSize));
        let vLines = new cv.Mat();
        cv.morphologyEx(warpedThresh, vLines, cv.MORPH_OPEN, vKernel);

        let gridOnly = new cv.Mat();
        cv.add(hLines, vLines, gridOnly);

        let hPos = getIntersections(true, Math.floor(size * 0.5), gridOnly);
        let vPos = getIntersections(false, Math.floor(size * 0.5), gridOnly);

        hKernel.delete(); hLines.delete();
        vKernel.delete(); vLines.delete();
        gridOnly.delete();

        // The coarse outer contour is only a rough locator, so it commonly
        // overshoots and swallows a header/label strip above or beside the
        // grid (e.g. row/column value labels). That strip's border shows up
        // here as one extra line whose gap to its neighbour is much smaller
        // than the real, uniform cell spacing. Drop those outliers so they
        // never get counted as a real grid line — otherwise the row/col
        // count is thrown off and the true grid ends up cropped.
        hPos = trimOutlierLines(hPos);
        vPos = trimOutlierLines(vPos);

        return { hPos, vPos };
    }

    // Removes leading/trailing lines whose gap to the next line is far
    // smaller than the median spacing of the rest — a sign that line is a
    // stray header/label divider rather than a genuine grid boundary.
    function trimOutlierLines(positions) {
        if (positions.length < 3) return positions;
        let trimmed = positions.slice();

        function medianGap(arr) {
            let gaps = [];
            for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
            gaps.sort((a, b) => a - b);
            return gaps[Math.floor(gaps.length / 2)];
        }

        while (trimmed.length > 2) {
            let med = medianGap(trimmed);
            let leadGap = trimmed[1] - trimmed[0];
            if (leadGap < med * 0.5) { trimmed.shift(); continue; }
            break;
        }
        while (trimmed.length > 2) {
            let med = medianGap(trimmed);
            let trailGap = trimmed[trimmed.length - 1] - trimmed[trimmed.length - 2];
            if (trailGap < med * 0.5) { trimmed.pop(); continue; }
            break;
        }
        return trimmed;
    }

    function verifyLineUniformity(positions, size) {
        if (positions.length < 3) return false;
        if (positions[0] > size * 0.2) return false;
        if (positions[positions.length - 1] < size * 0.8) return false;

        let spacings = [];
        for (let i = 1; i < positions.length; i++) spacings.push(positions[i] - positions[i - 1]);
        let maxS = Math.max(...spacings);
        let minS = Math.min(...spacings);
        if (maxS > minS * 3.0) return false;
        return true;
    }

    // The person now always tells us the expected grid size (2/3/4 Var), so
    // rather than guessing rows/cols from the line count, we confirm the
    // detected lines actually match that size. A genuine NxM grid has
    // exactly N+1 horizontal lines and M+1 vertical lines; anything else
    // (an outside label/line swept into the outer contour, a partly
    // occluded border, etc.) fails the match and this candidate is skipped.
    function validateExpectedGrid(expected, hPos, vPos) {
        if (!expected) return null;
        const size = TARGET_WARP_SIZE;
        if (!verifyLineUniformity(hPos, size) || !verifyLineUniformity(vPos, size)) return null;
        // Bucket-classify from the (already outlier-trimmed) line counts
        // instead of demanding an exact N+1 match. A little jitter or blur
        // can make one line drop out or double up on a given frame; that
        // shouldn't fail the whole match as long as it still clearly reads
        // as the expected size.
        let inferredCols = (hPos.length >= 5) ? 4 : 2;
        let inferredRows = (vPos.length >= 5) ? 4 : 2;
        if (inferredCols !== expected.cols || inferredRows !== expected.rows) return null;
        return expected;
    }


    // Snaps the rough contour corners to the true outer grid-line
    // intersections. The coarse quad only needs to roughly contain the
    // grid; this derives the tight, accurate boundary from it.
    function refineCorners(sortedPts, hPos, vPos, dstSize) {
        if (hPos.length < 2 || vPos.length < 2) return sortedPts; // nothing to refine against

        let left = hPos[0], right = hPos[hPos.length - 1];
        let top = vPos[0], bottom = vPos[vPos.length - 1];
        if (right - left < dstSize * 0.3 || bottom - top < dstSize * 0.3) return sortedPts; // too degenerate, keep original

        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            sortedPts[0].x, sortedPts[0].y, sortedPts[1].x, sortedPts[1].y,
            sortedPts[3].x, sortedPts[3].y, sortedPts[2].x, sortedPts[2].y
        ]);
        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0, dstSize, 0, 0, dstSize, dstSize, dstSize
        ]);
        let Minv = cv.getPerspectiveTransform(dstTri, srcTri);

        let ptsMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
            left, top, right, top, right, bottom, left, bottom
        ]);
        let outMat = new cv.Mat();
        cv.perspectiveTransform(ptsMat, outMat, Minv);

        let refined = [
            { x: outMat.data32F[0], y: outMat.data32F[1] },
            { x: outMat.data32F[2], y: outMat.data32F[3] },
            { x: outMat.data32F[4], y: outMat.data32F[5] },
            { x: outMat.data32F[6], y: outMat.data32F[7] }
        ];

        srcTri.delete(); dstTri.delete(); Minv.delete(); ptsMat.delete(); outMat.delete();
        return refined;
    }

    // ============================================================
    // Freeze + confidence-scored OCR
    // ============================================================

    function lockAndAnalyze(gridParams) {
        let cap = new cv.VideoCapture(video);
        let src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
        try {
            cap.read(src);
        } catch (e) {
            src.delete();
            resetToScanning();
            return;
        }
        analyzeFrame(src, gridParams.pts, gridParams.rows, gridParams.cols);
    }

    async function analyzeFrame(srcMat, pts, rows, cols) {
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            pts[0].x, pts[0].y, pts[1].x, pts[1].y,
            pts[3].x, pts[3].y, pts[2].x, pts[2].y
        ]);

        let dstSizeW = TARGET_WARP_SIZE;
        let dstSizeH = TARGET_WARP_SIZE;
        if (cols > rows) dstSizeH = TARGET_WARP_SIZE * (rows / cols);
        else if (rows > cols) dstSizeW = TARGET_WARP_SIZE * (cols / rows);

        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0, dstSizeW, 0, 0, dstSizeH, dstSizeW, dstSizeH
        ]);

        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        let warpedColor = new cv.Mat();
        cv.warpPerspective(srcMat, warpedColor, M, new cv.Size(dstSizeW, dstSizeH));

        // Snapshot for the review background (before we threshold it away)
        let snapCanvas = document.createElement('canvas');
        cv.imshow(snapCanvas, warpedColor);
        let imageDataURL = snapCanvas.toDataURL('image/jpeg', 0.9);

        let warped = new cv.Mat();
        cv.cvtColor(warpedColor, warped, cv.COLOR_RGBA2GRAY, 0);
        cv.adaptiveThreshold(warped, warped, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);

        let cellW = dstSizeW / cols;
        let cellH = dstSizeH / rows;

        let rawValues = []; // { val, confidence }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let padX = Math.floor(cellW * 0.2);
                let padY = Math.floor(cellH * 0.2);
                let rect = new cv.Rect(
                    Math.floor(c * cellW) + padX, Math.floor(r * cellH) + padY,
                    Math.floor(cellW) - 2 * padX, Math.floor(cellH) - 2 * padY
                );
                let cellMat = warped.roi(rect);

                let cellContours = new cv.MatVector();
                let cellHierarchy = new cv.Mat();
                cv.findContours(cellMat, cellContours, cellHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                let maxArea = 0;
                let bestDigitRect = null;
                for (let i = 0; i < cellContours.size(); ++i) {
                    let cnt = cellContours.get(i);
                    let area = cv.contourArea(cnt);
                    if (area > 30 && area > maxArea) {
                        maxArea = area;
                        bestDigitRect = cv.boundingRect(cnt);
                    }
                }

                if (!bestDigitRect) {
                    // No ink at all in this cell — genuinely blank, not a misread.
                    rawValues.push({ val: '', confidence: 100, hadInk: false });
                } else {
                    let digitMat = cellMat.roi(bestDigitRect);
                    let pad = 12;
                    let paddedMat = new cv.Mat(digitMat.rows + 2 * pad, digitMat.cols + 2 * pad, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
                    let roi = paddedMat.roi(new cv.Rect(pad, pad, digitMat.cols, digitMat.rows));
                    digitMat.copyTo(roi);
                    cv.bitwise_not(paddedMat, paddedMat);

                    let cellCanvas = document.createElement('canvas');
                    cv.imshow(cellCanvas, paddedMat);

                    try {
                        let { data } = await tesseractWorker.recognize(cellCanvas);
                        let val = (data.text || '').replace(/[^01xXdD]/g, '').trim().toUpperCase();
                        if (val === 'D') val = 'X';
                        let conf = typeof data.confidence === 'number' ? data.confidence : 0;
                        rawValues.push({ val: val ? val[0] : '', confidence: conf, hadInk: true });
                    } catch (e) {
                        rawValues.push({ val: '', confidence: 0, hadInk: true });
                    }

                    digitMat.delete(); paddedMat.delete(); roi.delete();
                }

                cellMat.delete(); cellContours.delete(); cellHierarchy.delete();
            }
        }

        warpedColor.delete(); warped.delete(); srcTri.delete(); dstTri.delete(); M.delete(); srcMat.delete();

        // Convention-based fill for cells with NO ink: many hand-drawn K-maps
        // only mark 1s/Xs and leave 0-cells blank. Base the guess only on
        // confidently-read cells, and only apply it to true blanks — never to
        // cells that had ink but failed to OCR (those stay blank + flagged,
        // since asserting a guessed digit there is more likely to be wrong).
        const CONF_THRESHOLD = 55;
        let confidentReads = rawValues.filter(v => v.hadInk && ['0', '1', 'X'].includes(v.val) && v.confidence >= CONF_THRESHOLD);
        let has1 = confidentReads.some(v => v.val === '1');
        let has0 = confidentReads.some(v => v.val === '0');
        let fillVal = '';
        if (has1 && !has0) fillVal = '0';
        else if (has0 && !has1) fillVal = '1';
        // if both or neither appear, leave blank cells blank rather than guessing 'X'

        let results = [];
        for (let i = 0; i < rawValues.length; i++) {
            let { val, confidence, hadInk } = rawValues[i];
            if (!hadInk) {
                // Truly blank cell: apply the convention guess if we have one,
                // still flagged gold since it's inferred, not read.
                results.push({ val: fillVal, auto: fillVal !== '', lowConf: fillVal !== '' });
            } else if (!['0', '1', 'X'].includes(val)) {
                // OCR didn't return a parseable character, but there's
                // clearly ink here — don't punt this to the user as blank.
                // Take the same best-guess convention used for blank cells
                // (or default to '1', since a marked cell is far more often
                // a 1/X than a genuine 0), and flag it gold for review.
                let guess = fillVal || '1';
                results.push({ val: guess, auto: true, lowConf: true });
            } else {
                // We got a plausible reading. Always take it as the best
                // guess rather than making the user type it — cells below
                // the confidence bar are just flagged gold (low-confidence)
                // so they're easy to spot and double-check.
                results.push({ val, auto: false, lowConf: confidence < CONF_THRESHOLD });
            }
        }

        reviewRows = rows;
        reviewCols = cols;
        reviewValues = results;
        showReview(imageDataURL);
    }

    // ============================================================
    // Review grid — tap any cell to correct it before proceeding
    // ============================================================

    function showReview(imageDataURL) {
        state = 'review';
        overlay.style.display = 'none';
        video.style.display = 'none';
        sizeRow.style.display = 'none';

        reviewContainer.style.display = 'flex';
        if (imageDataURL) {
            reviewImage.style.backgroundImage = `url(${imageDataURL})`;
            reviewImage.classList.remove('kmap-blank-grid');
        } else {
            reviewImage.style.backgroundImage = 'none';
            reviewImage.classList.add('kmap-blank-grid');
        }
        reviewImage.style.aspectRatio = `${reviewCols} / ${reviewRows}`;

        renderReviewGrid();
        updateExpressionPreview();

        statusMsg.innerText = imageDataURL
            ? 'Tap any cell to fix it, then Proceed.'
            : 'Tap cells to set values, then Proceed.';
        proceedBtn.style.display = 'block';
        rescanBtn.style.display = 'block';
    }

    function renderReviewGrid() {
        reviewGrid.innerHTML = '';
        reviewGrid.style.gridTemplateColumns = `repeat(${reviewCols}, 1fr)`;
        reviewGrid.style.gridTemplateRows = `repeat(${reviewRows}, 1fr)`;

        reviewValues.forEach((cell, idx) => {
            let btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kmap-cell-btn';
            btn.textContent = cell.val || '\u00B7'; // middle dot for blank
            if (cell.val === '') btn.classList.add('is-blank');
            if (cell.lowConf) btn.classList.add('low-confidence');
            if (cell.auto) btn.classList.add('was-auto');

            btn.addEventListener('click', () => {
                let next = CYCLE[(CYCLE.indexOf(cell.val) + 1) % CYCLE.length];
                cell.val = next;
                cell.auto = false;
                cell.lowConf = false;
                btn.textContent = next || '\u00B7';
                btn.classList.toggle('is-blank', next === '');
                btn.classList.remove('low-confidence', 'was-auto');
                updateExpressionPreview();
            });

            reviewGrid.appendChild(btn);
        });
    }

    function updateExpressionPreview() {
        const { vars, minterms, dontcares } = computeExpressionFromGrid(reviewRows, reviewCols, reviewValues);
        let expr = `${vars}: m(${minterms.join(',')})`;
        if (dontcares.length > 0) expr += ` d(${dontcares.join(',')})`;
        let previewEl = document.getElementById('kmap-expr-preview');
        if (previewEl) previewEl.textContent = (minterms.length || dontcares.length) ? expr : 'All cells are 0 — mark some 1s or Xs';
    }

    rescanBtn.addEventListener('click', () => {
        resetToScanning();
    });

    proceedBtn.addEventListener('click', () => {
        const { vars, minterms, dontcares } = computeExpressionFromGrid(reviewRows, reviewCols, reviewValues);
        let expr = `${vars}: m(${minterms.join(',')})`;
        if (dontcares.length > 0) expr += ` d(${dontcares.join(',')})`;

        const inputEl = document.getElementById('expression-input');
        if (inputEl) {
            inputEl.value = expr;
            inputEl.dispatchEvent(new Event('input'));
        }
        stopCamera();
        popup.style.display = 'none';
    });

    // ============================================================
    // Grid values -> minterm expression
    // ============================================================

    function computeExpressionFromGrid(rows, cols, values) {
        let vars = 'A,B';
        if (rows === 2 && cols === 4) vars = 'A,B,C';
        else if (rows === 4 && cols === 2) vars = 'A,B,C';
        else if (rows === 4 && cols === 4) vars = 'A,B,C,D';

        const G2 = [0, 1];
        const G4 = [0, 1, 3, 2];
        let minterms = [];
        let dontcares = [];

        for (let i = 0; i < values.length; i++) {
            let r = Math.floor(i / cols);
            let c = i % cols;
            let val = values[i].val;

            if (val === '1' || val === 'X') {
                let row_val = (rows === 2) ? G2[r] : G4[r];
                let col_val = (cols === 2) ? G2[c] : G4[c];
                let m = 0;

                if (rows === 2 && cols === 2) m = (row_val << 1) | col_val;
                else if (rows === 2 && cols === 4) m = (row_val << 2) | col_val;
                else if (rows === 4 && cols === 2) m = (row_val << 1) | col_val;
                else if (rows === 4 && cols === 4) m = (row_val << 2) | col_val;

                if (val === '1') minterms.push(m); else dontcares.push(m);
            }
        }

        minterms.sort((a, b) => a - b);
        dontcares.sort((a, b) => a - b);
        return { vars, minterms, dontcares };
    }

})();
