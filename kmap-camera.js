/**
 * K-Map Camera Module for Mantiq
 * Fullscreen Sudoku-style solver with strict grid verification and contour-isolated OCR.
 */

(function() {
    let video = document.getElementById('kmap-video');
    let overlay = document.getElementById('kmap-overlay-canvas');
    let statusMsg = document.getElementById('kmap-status-msg');
    let proceedBtn = document.getElementById('kmap-proceed-btn');
    let popup = document.getElementById('kmap-camera-popup');
    
    let stream = null;
    let scanning = false;
    let tesseractWorker = null;
    let ocrBusy = false;
    
    let latestGridParams = null; // { rows, cols, pts }
    let latestOCRResults = []; // values '0', '1', 'X'
    
    let finalVars = '';
    let finalMinterms = [];
    let finalDontCares = [];

    const TARGET_WARP_SIZE = 400;

    document.getElementById('kmap-camera-btn').addEventListener('click', async () => {
        popup.style.display = 'block';
        statusMsg.innerText = 'Initializing camera & OCR...';
        proceedBtn.style.display = 'none';
        
        latestGridParams = null;
        latestOCRResults = [];
        finalVars = '';
        
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
            
            video.onloadedmetadata = () => {
                video.width = video.videoWidth;
                video.height = video.videoHeight;
                overlay.width = video.videoWidth;
                overlay.height = video.videoHeight;
                scanning = true;
                ocrBusy = false;
                
                if (typeof cv !== 'undefined' && cv.Mat) {
                    statusMsg.innerText = 'Point camera at a K-Map...';
                    requestAnimationFrame(renderLoop);
                } else {
                    let waitCv = setInterval(() => {
                        if (typeof cv !== 'undefined' && cv.Mat) {
                            clearInterval(waitCv);
                            statusMsg.innerText = 'Point camera at a K-Map...';
                            requestAnimationFrame(renderLoop);
                        }
                    }, 500);
                }
            };
        } catch (err) {
            statusMsg.innerText = 'Camera access denied or unavailable.';
            console.error(err);
        }
    });

    document.getElementById('kmap-camera-close').addEventListener('click', stopCamera);

    function stopCamera() {
        scanning = false;
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }
        popup.style.display = 'none';
    }

    proceedBtn.addEventListener('click', () => {
        if (finalVars) {
            let expr = `${finalVars}: m(${finalMinterms.join(',')})`;
            if (finalDontCares.length > 0) {
                expr += ` d(${finalDontCares.join(',')})`;
            }
            
            const inputEl = document.getElementById('expression-input');
            if (inputEl) {
                inputEl.value = expr;
                inputEl.dispatchEvent(new Event('input'));
            }
            stopCamera();
        }
    });

    function distance(p1, p2) {
        return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    function getGridSizeRobust(warpedThresh) {
        let size = TARGET_WARP_SIZE;
        let colSums = new Float32Array(size);
        let rowSums = new Float32Array(size);
        
        // Ignore outer 15% to strictly avoid bounding box borders
        let margin = Math.floor(size * 0.15);
        
        for (let y = margin; y < size - margin; y++) {
            let rowPtr = warpedThresh.ucharPtr(y);
            for (let x = margin; x < size - margin; x++) {
                if (rowPtr[x] > 128) {
                    colSums[x]++;
                    rowSums[y]++;
                }
            }
        }
        
        let xThreshold = (size - 2*margin) * 0.2; // 20% of vertical length
        let yThreshold = (size - 2*margin) * 0.2; // 20% of horizontal length
        
        let xPeaks = 0;
        let inXPeak = false;
        for (let i = margin; i < size - margin; i++) {
            if (colSums[i] > xThreshold) {
                if (!inXPeak) { xPeaks++; inXPeak = true; }
            } else { inXPeak = false; }
        }
        
        let yPeaks = 0;
        let inYPeak = false;
        for (let i = margin; i < size - margin; i++) {
            if (rowSums[i] > yThreshold) {
                if (!inYPeak) { yPeaks++; inYPeak = true; }
            } else { inYPeak = false; }
        }
        
        // internal lines + 1 = total cells per dimension
        let rows = yPeaks + 1;
        let cols = xPeaks + 1;
        
        if ((rows === 2 || rows === 4) && (cols === 2 || cols === 4)) {
            return { rows, cols };
        }
        return null;
    }

    function renderLoop() {
        if (!scanning) return;

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
        
        // Morphological closing to seal grid lines
        let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);
        
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(thresh, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        
        let maxArea = 0;
        let bestQuad = null;
        let bestGridParams = null;
        
        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let hull = new cv.Mat();
            cv.convexHull(cnt, hull, false, true);
            let area = cv.contourArea(hull);
            
            if (area > 20000 && area > maxArea) {
                let peri = cv.arcLength(hull, true);
                let approx = new cv.Mat();
                cv.approxPolyDP(hull, approx, 0.05 * peri, true);
                
                if (approx.rows === 4) {
                    let validAngles = true;
                    for (let j = 0; j < 4; j++) {
                        let p1 = {x: approx.data32S[j*2], y: approx.data32S[j*2+1]};
                        let p2 = {x: approx.data32S[((j+1)%4)*2], y: approx.data32S[((j+1)%4)*2+1]};
                        let p3 = {x: approx.data32S[((j+2)%4)*2], y: approx.data32S[((j+2)%4)*2+1]};
                        
                        let v1 = {x: p1.x - p2.x, y: p1.y - p2.y};
                        let v2 = {x: p3.x - p2.x, y: p3.y - p2.y};
                        
                        let dot = v1.x*v2.x + v1.y*v2.y;
                        let mag1 = Math.hypot(v1.x, v1.y);
                        let mag2 = Math.hypot(v2.x, v2.y);
                        let angle = Math.acos(dot / (mag1 * mag2)) * 180 / Math.PI;
                        
                        if (angle < 60 || angle > 120) { validAngles = false; break; }
                    }
                    
                    if (validAngles) {
                        // Strict Verification: Warp it and check for internal grid lines
                        let pts = [];
                        for (let k = 0; k < 4; k++) pts.push({x: approx.data32S[k*2], y: approx.data32S[k*2+1]});
                        pts.sort((a,b) => a.y - b.y);
                        let top = pts.slice(0,2).sort((a,b) => a.x - b.x);
                        let bottom = pts.slice(2,4).sort((a,b) => a.x - b.x);
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
                        
                        let gridCheck = getGridSizeRobust(warped);
                        if (gridCheck) {
                            maxArea = area;
                            if (bestQuad) bestQuad.delete();
                            bestQuad = approx.clone();
                            bestGridParams = { pts: sortedPts, rows: gridCheck.rows, cols: gridCheck.cols };
                        }
                        
                        srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
                    }
                }
                approx.delete();
            }
            hull.delete();
            cnt.delete();
        }
        
        let ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        
        if (bestQuad && bestGridParams) {
            let sortedPts = bestGridParams.pts;
            let rows = bestGridParams.rows;
            let cols = bestGridParams.cols;
            latestGridParams = bestGridParams;
            
            // Draw grid bounds
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(sortedPts[0].x, sortedPts[0].y);
            ctx.lineTo(sortedPts[1].x, sortedPts[1].y);
            ctx.lineTo(sortedPts[2].x, sortedPts[2].y);
            ctx.lineTo(sortedPts[3].x, sortedPts[3].y);
            ctx.closePath();
            ctx.stroke();

            // Draw inner grid lines
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
            
            // Render OCR Results over cells
            if (latestOCRResults.length === rows * cols) {
                ctx.font = 'bold 36px Outfit, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        let obj = latestOCRResults[r * cols + c];
                        let val = obj.val;
                        let isAuto = obj.autoFilled;
                        
                        let cX = sortedPts[0].x + (sortedPts[1].x - sortedPts[0].x) * ((c + 0.5)/cols) + (sortedPts[3].x - sortedPts[0].x) * ((r + 0.5)/rows);
                        let cY = sortedPts[0].y + (sortedPts[1].y - sortedPts[0].y) * ((c + 0.5)/cols) + (sortedPts[3].y - sortedPts[0].y) * ((r + 0.5)/rows);
                        
                        let textW = ctx.measureText(val).width;
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                        ctx.beginPath();
                        ctx.roundRect(cX - textW/2 - 10, cY - 24, textW + 20, 48, 8);
                        ctx.fill();
                        
                        ctx.fillStyle = isAuto ? '#ffd700' : '#ffffff';
                        ctx.shadowColor = 'rgba(0,0,0,0.8)';
                        ctx.shadowBlur = 6;
                        ctx.fillText(val, cX, cY);
                        ctx.shadowBlur = 0;
                    }
                }
            }
            
            if (!ocrBusy) {
                ocrBusy = true;
                let srcClone = src.clone();
                runOCR(srcClone, sortedPts, rows, cols);
            }
            
            bestQuad.delete();
        } else {
            latestGridParams = null;
            statusMsg.innerText = 'Looking for a strict K-Map grid...';
            proceedBtn.style.display = 'none';
        }
        
        src.delete(); gray.delete(); blurred.delete(); thresh.delete();
        kernel.delete();
        contours.delete(); hierarchy.delete();
        
        if (scanning) {
            requestAnimationFrame(renderLoop);
        }
    }

    async function runOCR(srcMat, pts, rows, cols) {
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            pts[0].x, pts[0].y, pts[1].x, pts[1].y,
            pts[3].x, pts[3].y, pts[2].x, pts[2].y
        ]);
        
        let dstSizeW = TARGET_WARP_SIZE;
        let dstSizeH = TARGET_WARP_SIZE * (rows / cols);
        if (cols > rows) dstSizeH = TARGET_WARP_SIZE * (rows / cols);
        else if (rows > cols) dstSizeW = TARGET_WARP_SIZE * (cols / rows);
        else { dstSizeW = TARGET_WARP_SIZE; dstSizeH = TARGET_WARP_SIZE; }

        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0, dstSizeW, 0, 0, dstSizeH, dstSizeW, dstSizeH
        ]);
        
        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        let warped = new cv.Mat();
        cv.warpPerspective(srcMat, warped, M, new cv.Size(dstSizeW, dstSizeH));
        
        cv.cvtColor(warped, warped, cv.COLOR_RGBA2GRAY, 0);
        cv.adaptiveThreshold(warped, warped, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);
        
        let cellW = dstSizeW / cols;
        let cellH = dstSizeH / rows;
        
        let rawValues = [];
        
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                // Aggressive 20% crop to eliminate all cell borders
                let padX = Math.floor(cellW * 0.2);
                let padY = Math.floor(cellH * 0.2);
                let rect = new cv.Rect(Math.floor(c*cellW) + padX, Math.floor(r*cellH) + padY, Math.floor(cellW) - 2*padX, Math.floor(cellH) - 2*padY);
                let cellMat = warped.roi(rect);
                
                // Find digit contour
                let cellContours = new cv.MatVector();
                let cellHierarchy = new cv.Mat();
                cv.findContours(cellMat, cellContours, cellHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
                
                let maxArea = 0;
                let bestDigitRect = null;
                for (let i = 0; i < cellContours.size(); ++i) {
                    let cnt = cellContours.get(i);
                    let area = cv.contourArea(cnt);
                    // Filter out microscopic noise
                    if (area > 30 && area > maxArea) {
                        maxArea = area;
                        bestDigitRect = cv.boundingRect(cnt);
                    }
                }
                
                if (!bestDigitRect) {
                    // Mathematically guaranteed empty cell
                    rawValues.push('');
                } else {
                    // Extract just the digit bounding box
                    let digitMat = cellMat.roi(bestDigitRect);
                    
                    // Pad with white space for Tesseract
                    let pad = 12;
                    let paddedMat = new cv.Mat(digitMat.rows + 2*pad, digitMat.cols + 2*pad, cv.CV_8UC1, new cv.Scalar(0,0,0,0));
                    
                    let roi = paddedMat.roi(new cv.Rect(pad, pad, digitMat.cols, digitMat.rows));
                    digitMat.copyTo(roi);
                    
                    // Invert to black-text-on-white-background for OCR
                    cv.bitwise_not(paddedMat, paddedMat);
                    
                    let cellCanvas = document.createElement('canvas');
                    cv.imshow(cellCanvas, paddedMat);
                    
                    let { data: { text } } = await tesseractWorker.recognize(cellCanvas);
                    let val = text.replace(/[^01xXdD]/g, '').trim().toUpperCase();
                    if (val === 'D') val = 'X';
                    
                    if (val === '') rawValues.push('');
                    else rawValues.push(val[0]);
                    
                    digitMat.delete(); paddedMat.delete(); roi.delete();
                }
                
                cellMat.delete(); cellContours.delete(); cellHierarchy.delete();
            }
        }
        
        warped.delete(); srcTri.delete(); dstTri.delete(); M.delete(); srcMat.delete();

        // Auto-fill logic
        let has1 = rawValues.includes('1');
        let has0 = rawValues.includes('0');
        let fillVal = '';
        if (has1 && !has0) fillVal = '0';
        else if (has0 && !has1) fillVal = '1';
        else if (has1 && has0) fillVal = 'X';
        
        let results = [];
        for (let i = 0; i < rawValues.length; i++) {
            let val = rawValues[i];
            if (val === '' || !['0','1','X'].includes(val)) {
                results.push({ val: fillVal || 'X', autoFilled: true });
            } else {
                results.push({ val: val, autoFilled: false });
            }
        }
        
        latestOCRResults = results;
        
        // Calculate Expression
        let vars = 'A,B';
        if (rows === 2 && cols === 4) vars = 'A,B,C';
        else if (rows === 4 && cols === 2) vars = 'A,B,C';
        else if (rows === 4 && cols === 4) vars = 'A,B,C,D';
        
        let G2 = [0, 1];
        let G4 = [0, 1, 3, 2];
        let minterms = [];
        let dontcares = [];
        
        for (let i = 0; i < results.length; i++) {
            let r = Math.floor(i / cols);
            let c = i % cols;
            let val = results[i].val;
            
            if (val === '1' || val === 'X') {
                let row_val = (rows === 2) ? G2[r] : G4[r];
                let col_val = (cols === 2) ? G2[c] : G4[c];
                let m = 0;
                
                if (rows === 2 && cols === 2) m = (row_val << 1) | col_val;
                else if (rows === 2 && cols === 4) m = (row_val << 2) | col_val;
                else if (rows === 4 && cols === 2) m = (row_val << 1) | col_val;
                else if (rows === 4 && cols === 4) m = (row_val << 2) | col_val;
                
                if (val === '1') minterms.push(m);
                else dontcares.push(m);
            }
        }
        
        minterms.sort((a,b) => a-b);
        dontcares.sort((a,b) => a-b);
        
        finalVars = vars;
        finalMinterms = minterms;
        finalDontCares = dontcares;
        
        statusMsg.innerText = `Recognized ${rows}x${cols} Grid. Proceed when ready.`;
        proceedBtn.style.display = 'block';
        
        ocrBusy = false;
    }

})();
