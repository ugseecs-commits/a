/**
 * WebBridge_web.cpp — Lean WASM ↔ JS bridge for mantiq-main
 *
 * Exposes the same mantiq_* C API as the original WebBridge.cpp,
 * but works directly against the global AppState g_state — no Raylib,
 * no Application, no CircuitRenderer involved at all.
 *
 * The two helper methods previously delegated to CircuitRenderer
 * (toggleAllVariables, collectInputStates) are inlined here as simple
 * recursive tree walks — they never needed rendering.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "app/AppState.h"
#include "circuit/CircuitNode.h"
#include "circuit/VerilogGenerator.h"
#include "logic/ExpressionProcessor.h"

#include <string>
#include <vector>
#include <map>
#include <set>
#include <cmath>
#include <cstring>
#include <cstdlib>

using namespace com::mantiq;
using namespace com::mantiq::app;
using namespace com::mantiq::circuit;
using namespace com::mantiq::logic;

// Declared in main_web.cpp
extern AppState g_state;

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

/** Heap-allocate a copy of str so JS can hold it until mantiq_freeStr(). */
static const char* copyToBridge(const std::string& str) {
    char* res = static_cast<char*>(std::malloc(str.length() + 1));
    if (res) std::strcpy(res, str.c_str());
    return res;
}

/** Recursive: build JSON for a circuit node tree. */
static std::string nodeToJSON(const CircuitNodePtr& node) {
    if (!node) return "null";
    std::string json = "{";
    json += "\"isGate\":" + std::string(node->isGate() ? "true" : "false") + ",";

    if (node->isGate()) {
        std::string t = "AND";
        if (node->getType() == NodeType::OR)  t = "OR";
        else if (node->getType() == NodeType::NOT) t = "NOT";
        json += "\"type\":\"" + t + "\",";
    } else {
        std::string val = node->getValue();
        std::string escaped;
        for (char c : val) {
            if (c == '"')  escaped += "\\\"";
            else if (c == '\\') escaped += "\\\\";
            else escaped += c;
        }
        json += "\"type\":\"VAR\",";
        json += "\"value\":\"" + escaped + "\",";
    }

    json += "\"children\":[";
    const auto& children = node->getChildren();
    for (size_t i = 0; i < children.size(); i++) {
        json += nodeToJSON(children[i]);
        if (i + 1 < children.size()) json += ",";
    }
    json += "]}";
    return json;
}

/** Recursive: toggle every variable node whose name matches varName. */
static void toggleVarInTree(const CircuitNodePtr& node, const char* varName) {
    if (!node) return;
    if (node->isVariable() && node->getValue() == varName) {
        node->toggle();
    }
    for (const auto& child : node->getChildren()) {
        toggleVarInTree(child, varName);
    }
}

/** Recursive: collect {name → on} for every variable leaf. */
static void collectStatesRecursive(const CircuitNodePtr& node,
                                   std::map<std::string, bool>& out) {
    if (!node) return;
    if (node->isVariable()) {
        out[node->getValue()] = node->isOn();
        return;
    }
    for (const auto& child : node->getChildren()) {
        collectStatesRecursive(child, out);
    }
}

// ─────────────────────────────────────────────
//  Exported C API
// ─────────────────────────────────────────────

extern "C" {

EMSCRIPTEN_KEEPALIVE void mantiq_setExpression(const char* expr) {
    g_state.setInputText(expr ? expr : "");
    g_state.processInput(false); // Skip ASTProver by default for instant UI updates
}

EMSCRIPTEN_KEEPALIVE void mantiq_runAlgebraicProof() {
    g_state.processInput(true); // Re-run current expression with ASTProver proof
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getExpression() {
    return copyToBridge(g_state.getInputText());
}

EMSCRIPTEN_KEEPALIVE void mantiq_setSOP(int sop) {
    g_state.setSOP(sop != 0);
    g_state.setHasProcessed(false); // force circuit rebuild on next query
}

// View is managed fully by JS/HTML in the lean build.
// We keep a simple integer so mantiq_getView() / mantiq_setView() stay compatible.
static int s_currentView = 0;

EMSCRIPTEN_KEEPALIVE void mantiq_setView(int mode) {
    s_currentView = mode;
    // Also update AppState so ensureCircuitsBuilt() respects SOP/POS selection
    // when view 0 (simulation) or 1 (circuit) is active.
    // No Raylib CircuitRenderer.setSimpleStyle() needed — that was only for drawing.
}

EMSCRIPTEN_KEEPALIVE int mantiq_getView() {
    return s_currentView;
}

EMSCRIPTEN_KEEPALIVE void mantiq_toggleVariable(const char* name) {
    if (!name) return;
    g_state.ensureCircuitsBuilt();
    CircuitNodePtr orig = g_state.getOriginalCircuit();
    CircuitNodePtr simp = g_state.getSimplifiedCircuit();
    if (orig) toggleVarInTree(orig, name);
    if (simp) toggleVarInTree(simp, name);
}

EMSCRIPTEN_KEEPALIVE void mantiq_setSelectedSolution(int index) {
    g_state.setSelectedSolutionIndex(index);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getSimplifiedExpr() {
    return copyToBridge(g_state.getSimplifiedExpression());
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getAllSolutions() {
    std::vector<std::string> sols = g_state.getAllSolutions();
    std::string json = "[";
    for (size_t i = 0; i < sols.size(); i++) {
        std::string escaped;
        for (char c : sols[i]) {
            if (c == '"') escaped += "\\\"";
            else escaped += c;
        }
        json += "\"" + escaped + "\"";
        if (i + 1 < sols.size()) json += ",";
    }
    json += "]";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getQMSteps() {
    return copyToBridge(g_state.getProcessResult().getStepsLog());
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getVariables() {
    std::vector<std::string> vars = g_state.getProcessResult().getVariables();
    std::string json = "[";
    for (size_t i = 0; i < vars.size(); i++) {
        json += "\"" + vars[i] + "\"";
        if (i + 1 < vars.size()) json += ",";
    }
    json += "]";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getVariableStates() {
    g_state.ensureCircuitsBuilt();
    CircuitNodePtr orig = g_state.getOriginalCircuit();

    std::map<std::string, bool> states;
    if (orig) {
        collectStatesRecursive(orig, states);
    } else {
        for (const auto& v : g_state.getProcessResult().getVariables())
            states[v] = false;
    }

    std::string json = "{";
    size_t count = 0;
    for (const auto& pair : states) {
        json += "\"" + pair.first + "\":" + (pair.second ? "true" : "false");
        if (++count < states.size()) json += ",";
    }
    json += "}";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getTruthTableJSON() {
    const auto& result = g_state.getProcessResult();
    const auto& variables = result.getVariables();
    if (variables.empty()) return nullptr;

    int numVars = static_cast<int>(variables.size());
    int numRows = static_cast<int>(std::pow(2, numVars));
    const auto& minterms   = result.getMinterms();
    const auto& dontCares  = result.getDontCares();
    std::set<int> mintermSet(minterms.begin(), minterms.end());
    std::set<int> dontCareSet(dontCares.begin(), dontCares.end());
    const auto& simplifiedTerms = result.getSimplifiedTerms();

    std::string json = "{\"variables\":[";
    for (size_t i = 0; i < variables.size(); i++) {
        json += "\"" + variables[i] + "\"";
        if (i + 1 < variables.size()) json += ",";
    }
    json += "],\"rows\":[";

    for (int i = 0; i < numRows; i++) {
        // Determine simplified output
        bool simplifiedOut = false;
        if (mintermSet.count(i)) {
            simplifiedOut = true;
        } else if (dontCareSet.count(i) && !simplifiedTerms.empty()) {
            std::string rowBin;
            for (int b = numVars - 1; b >= 0; b--)
                rowBin += ((i >> b) & 1) ? '1' : '0';
            for (const auto& term : simplifiedTerms) {
                bool match = true;
                int len = std::min(static_cast<int>(term.length()), numVars);
                for (int c = 0; c < len; c++) {
                    if (term[c] != '-' && term[c] != rowBin[c]) { match = false; break; }
                }
                if (match) { simplifiedOut = true; break; }
            }
        }

        json += "{\"row\":" + std::to_string(i) + ",\"inputs\":[";
        for (int v = numVars - 1; v >= 0; v--) {
            json += ((i >> v) & 1) ? "true" : "false";
            if (v > 0) json += ",";
        }
        std::string out      = dontCareSet.count(i) ? "\"X\"" : (mintermSet.count(i) ? "\"1\"" : "\"0\"");
        std::string simpOut  = simplifiedOut ? "\"1\"" : "\"0\"";
        json += "],\"output\":" + out + ",\"simplified_output\":" + simpOut + "}";
        if (i + 1 < numRows) json += ",";
    }
    json += "]}";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getKMapJSON() {
    if (!g_state.hasValidResult()) return nullptr;

    const ProcessResult& result = g_state.getProcessResult();
    const auto& variables              = result.getVariables();
    const auto& minterms               = result.getMinterms();
    const auto& dontCares              = result.getDontCares();
    const auto& allRawSolutions        = result.getAllRawSolutions();
    const auto& allRawSolutionsPOS     = result.getAllRawSolutionsPOS();
    const auto& primeImpls             = result.getPrimeImplicants();
    const auto& essentialPrimeImpls    = result.getEssentialPrimeImplicants();
    const auto& primeImplsPOS          = result.getPrimeImplicantsPOS();
    const auto& essentialPrimeImplsPOS = result.getEssentialPrimeImplicantsPOS();

    std::string json = "{";

    // Variables
    json += "\"variables\":[";
    for (size_t i = 0; i < variables.size(); i++) {
        json += "\"" + variables[i] + "\"";
        if (i + 1 < variables.size()) json += ",";
    }
    json += "],";

    // Minterms
    json += "\"minterms\":[";
    for (size_t i = 0; i < minterms.size(); i++) {
        json += std::to_string(minterms[i]);
        if (i + 1 < minterms.size()) json += ",";
    }
    json += "],";

    // Don't cares
    json += "\"dontCares\":[";
    for (size_t i = 0; i < dontCares.size(); i++) {
        json += std::to_string(dontCares[i]);
        if (i + 1 < dontCares.size()) json += ",";
    }
    json += "],";

    // SOP solutions
    json += "\"solutions\":[";
    for (size_t i = 0; i < allRawSolutions.size(); i++) {
        json += "[";
        for (size_t j = 0; j < allRawSolutions[i].size(); j++) {
            json += "\"" + allRawSolutions[i][j] + "\"";
            if (j + 1 < allRawSolutions[i].size()) json += ",";
        }
        json += "]";
        if (i + 1 < allRawSolutions.size()) json += ",";
    }
    json += "],";

    // Prime implicants helpers
    auto addStrArray = [&](const std::string& key, const std::vector<std::string>& arr) {
        json += "\"" + key + "\":[";
        for (size_t i = 0; i < arr.size(); i++) {
            json += "\"" + arr[i] + "\"";
            if (i + 1 < arr.size()) json += ",";
        }
        json += "],";
    };

    addStrArray("primeImplicants",             primeImpls);
    addStrArray("essentialPrimeImplicants",    essentialPrimeImpls);
    addStrArray("primeImplicantsPOS",          primeImplsPOS);
    addStrArray("essentialPrimeImplicantsPOS", essentialPrimeImplsPOS);

    // POS solutions (last — no trailing comma)
    json += "\"solutionsPOS\":[";
    for (size_t i = 0; i < allRawSolutionsPOS.size(); i++) {
        json += "[";
        for (size_t j = 0; j < allRawSolutionsPOS[i].size(); j++) {
            json += "\"" + allRawSolutionsPOS[i][j] + "\"";
            if (j + 1 < allRawSolutionsPOS[i].size()) json += ",";
        }
        json += "]";
        if (i + 1 < allRawSolutionsPOS.size()) json += ",";
    }
    json += "]}";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getCircuitJSON() {
    g_state.ensureCircuitsBuilt();
    const auto& result = g_state.getProcessResult();

    std::string json = "{";
    json += "\"isAlwaysTrue\":"  + std::string(result.isAlwaysTrue()  ? "true" : "false") + ",";
    json += "\"isAlwaysFalse\":" + std::string(result.isAlwaysFalse() ? "true" : "false") + ",";

    CircuitNodePtr orig = g_state.getOriginalCircuit();
    CircuitNodePtr simp = g_state.getSimplifiedCircuit();
    json += "\"original\":"   + nodeToJSON(orig) + ",";
    json += "\"simplified\":" + nodeToJSON(simp);
    json += "}";
    return copyToBridge(json);
}

EMSCRIPTEN_KEEPALIVE const char* mantiq_getVerilogCode(int isGateLevel, int addTestbench) {
    g_state.ensureCircuitsBuilt();
    CircuitNodePtr simpCircuit = g_state.getSimplifiedCircuit();
    if (!simpCircuit) return nullptr;

    const auto& result = g_state.getProcessResult();
    std::string constantOutput =
        result.isAlwaysTrue()  ? "1" :
        result.isAlwaysFalse() ? "0" : "";

    bool withTb = (addTestbench != 0);

    std::string code = isGateLevel
        ? VerilogGenerator::generateGateLevel (simpCircuit, result.getVariables(), constantOutput, withTb)
        : VerilogGenerator::generateDataflow  (simpCircuit, result.getVariables(), constantOutput, withTb);

    return copyToBridge(code);
}

EMSCRIPTEN_KEEPALIVE int mantiq_isAlwaysTrue() {
    return g_state.getProcessResult().isAlwaysTrue() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int mantiq_isAlwaysFalse() {
    return g_state.getProcessResult().isAlwaysFalse() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int mantiq_isSyntaxValid(const char* expr) {
    return ExpressionProcessor::isValidSyntax(expr ? expr : "") ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int mantiq_hasResult() {
    return g_state.hasValidResult() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void mantiq_freeStr(const char* ptr) {
    std::free(const_cast<void*>(static_cast<const void*>(ptr)));
}

} // extern "C"
