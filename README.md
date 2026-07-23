# mantiq — منطق
### A Live, Web-Based Digital Logic Calculator & Visualizer

> *"We are engineers. It is time we stop doing a machine's job."*

[![Live Demo](https://img.shields.io/badge/Live%20Demo-ugseecs.github.io%2Fmantiq-blue?style=for-the-badge)](https://ugseecs.github.io/mantiq)
[![PWA Ready](https://img.shields.io/badge/PWA-Offline%20Ready-success?style=for-the-badge)](https://ugseecs.github.io/mantiq)
[![License](https://img.shields.io/badge/License-Free%20Forever-orange?style=for-the-badge)](#)

---

## What Is This?

So, I was deep in a DLD assignment, it was 2 AM, and I had just miscalculated a minterm on a 6-variable K-Map. My entire Boolean expression collapsed. Again. The assignment was due in six hours.

At some point, staring at a grid of 64 cells and trying to mentally trace corner adjacencies across two dimensions (that fundamentally cannot represent six variables correctly anyway), I had a thought: *this is exactly the kind of tedious, error-prone, mechanical work that computers were invented to eliminate.*

So instead of fixing my K-Map, I started building mantiq.

**mantiq** (Arabic/Urdu: منطق — *logic*) is a complete Digital Logic Design toolkit that runs entirely in your browser. Feed it a Boolean expression. It handles the rest; minimization, visualization, circuit simulation, and Verilog generation; all live, all instantly.

No installation. No Python environment to configure. No MATLAB license to beg your university for. Just open the link.

---

## Features

### ⚙️ Quine-McCluskey Proof Engine
Most tools hand you a minimized expression and expect you to trust it. mantiq doesn't work that way.

Feed it any Sum of Products (SOP) or Product of Sums (POS) expression with up to **6 variables**, and it will generate the complete, step-by-step Q-M working, every implicant group, every comparison, every elimination; exactly as you would write it in a formal proof. Your lab report writes itself.

### 🧊 Native 3D K-Maps
Here is a fact that your DLD textbook glosses over: a 2D Karnaugh Map **fundamentally breaks down** at 5 and 6 variables. The adjacencies wrap around in ways a flat grid cannot honestly represent, and most students (and, frankly, some professors) just guess their way through it.

mantiq maps 5- and 6-variable logic into **interactive 3D space**. Spin the map. Watch corner adjacencies become visually obvious. Identify Prime Implicants without holding a mental model of a folded grid in your head.

### ⚡ Live Circuit Simulation
Toggle inputs. Watch signal propagation happen in real time across your logic gates. Verify your architecture virtually before you ever touch a breadboard or burn out another IC.

This is not a static diagram. It is a live simulation tied directly to the expression you entered.

### 📄 1-Click Export
- **Truth Tables** → CSV, ready for a report or spreadsheet
- **K-Maps, Circuit Diagrams, Waveforms** → PNG, ready to drop into any document

### 📟 Instant Verilog Generation
mantiq translates your minimized logic expression directly into:
- **Dataflow-level Verilog** (`assign` statements)
- **Gate-level Verilog** (structural primitives)

Stop writing boilerplate. Start thinking about architecture.

### 📶 Works Offline (PWA)
mantiq is a Progressive Web App. Once loaded, it caches locally and runs fully offline. Take it into your lab, your exam (oops! don't), or wherever the university Wi-Fi inevitably fails you.

---

## Supported Input Syntax

mantiq is flexible. Write your expressions the way that feels natural:

| Operator | Accepted Forms |
|---|---|
| **AND** | `A AND B` · `A.B` · `A(B)` · `AB` |
| **OR** | `A OR B` · `A\|B` · `A+B` |
| **NOT** | `NOT A` · `A'` · `~A` · `!A` |
| **XOR** | `A XOR B` · `A^B` |
| **Implication** | `A=>B` · `A->B` |

No rigid formatting required. Type it the way you think it.

---

## Getting Started

**No setup. Just open:**

🔗 **[ugseecs.github.io/mantiq](https://ugseecs.github.io/mantiq)**

That's it. For offline use, install it as a PWA through your browser's "Add to Home Screen" or "Install App" prompt.

---

## A Note on the Repository

> ⚠️ **This repository does not contain the application's source code.**

mantiq was built in **C++ using Raylib**, then compiled to WebAssembly via **Emscripten** for browser deployment. What you see here; `index.html`, `index.js`, `index.data`, `index.wasm`; are the **compiled build artifacts** deployed to GitHub Pages.

The source code lives separately. This repo exists purely to serve the live application through GitHub Pages.

---

## Variables & Scope

| Capability | Limit |
|---|---|
| Boolean variables | Up to 6 |
| Minimization methods | SOP & POS |
| K-Map dimensions | 2D (2–4 vars) · 3D (5–6 vars) |
| Verilog output styles | Dataflow & Gate-level |
| Export formats | CSV, PNG |
| Connectivity required | None (after first load) |

---

## Who Is This For?

- **BSCS / BSEE / CE students** grinding through DLD labs
- **Instructors** who want live in-class demonstrations of minimization
- **Hobbyists** working on FPGA or microcontroller logic
- **Anyone** who has ever lost marks because they misread a K-Map grouping at 2 AM

mantiq was originally built for my batchmates at **SEECS, NUST**; but logic is universal, and so is the frustration of doing by hand what a machine can do in milliseconds.

---

## Feedback & Contributions

Found a bug? Have a feature that would have saved you in your last lab? Open an issue or reach out directly.

The only lifetime subscription cost for mantiq is remembering me in your prayer; which, if this ever saves your GPA, I think is more than fair.

---

## License

Free to use. Free to share. Built for students, by a student who really should have been sleeping.

---
## Author

**Usama Gulzar**
---

<div align="center">

Built with **C++** · **Raylib** · **Emscripten** · **WebAssembly**

Deployed via **GitHub Pages** · Runs as a **PWA**

---

**منطق — Because logic should be the easy part.**

</div>
