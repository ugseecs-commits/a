/**
 * main_web.cpp — Lean WASM entry point for mantiq-main
 *
 * No Raylib. No window. No render loop. No preloaded data.
 * The global AppState (g_state) lives here and is accessed
 * by WebBridge_web.cpp through all exported mantiq_* functions.
 */

#include "app/AppState.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

using namespace com::mantiq::app;

// Global state — the single source of truth for the backend
AppState g_state;

int main() {
#ifdef __EMSCRIPTEN__
    // Signal to app.js that the WASM engine is ready
    EM_ASM({
        if (typeof window !== 'undefined' && window.onMantiqInit) {
            window.onMantiqInit();
        }
    });
#endif
    return 0;
}
