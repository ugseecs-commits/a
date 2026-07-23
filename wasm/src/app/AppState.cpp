#include "AppState.h"
#include "../logic/ExpressionProcessor.h"
#include "../circuit/CircuitBuilder.h"
#include <algorithm>

namespace com::mantiq::app {

AppState::AppState() {
    processResult = logic::ProcessResult::empty();
}

void AppState::setInputText(const std::string& text) {
    inputText = text;
    cursorPosition = static_cast<int>(inputText.length());
}

void AppState::setCursorPosition(int pos) {
    cursorPosition = std::max(0, std::min(pos, static_cast<int>(inputText.length())));
}

void AppState::moveCursorLeft() {
    if (cursorPosition > 0)
        cursorPosition--;
}

void AppState::moveCursorRight() {
    if (cursorPosition < static_cast<int>(inputText.length()))
        cursorPosition++;
}

void AppState::moveCursorToStart() {
    cursorPosition = 0;
}

void AppState::moveCursorToEnd() {
    cursorPosition = static_cast<int>(inputText.length());
}

void AppState::appendToInput(char c) {
    if (inputText.length() < 199) {
        inputText = inputText.substr(0, cursorPosition) + c + inputText.substr(cursorPosition);
        cursorPosition++;
        syntaxVal = logic::ExpressionProcessor::isValidSyntax(inputText);
    }
}

void AppState::insertTextAtCursor(const std::string& text) {
    if (text.empty())
        return;
    int available = 199 - static_cast<int>(inputText.length());
    if (available <= 0)
        return;
    std::string toInsert = text;
    if (static_cast<int>(text.length()) > available) {
        toInsert = text.substr(0, available);
    }
    inputText = inputText.substr(0, cursorPosition) + toInsert + inputText.substr(cursorPosition);
    cursorPosition += static_cast<int>(toInsert.length());
    syntaxVal = logic::ExpressionProcessor::isValidSyntax(inputText);
}

void AppState::deleteLastChar() {
    if (cursorPosition > 0) {
        inputText = inputText.substr(0, cursorPosition - 1) + inputText.substr(cursorPosition);
        cursorPosition--;
        syntaxVal = logic::ExpressionProcessor::isValidSyntax(inputText);
    }
}

void AppState::deleteNextChar() {
    if (cursorPosition < static_cast<int>(inputText.length())) {
        inputText = inputText.substr(0, cursorPosition) + inputText.substr(cursorPosition + 1);
        syntaxVal = logic::ExpressionProcessor::isValidSyntax(inputText);
    }
}

void AppState::clearInput() {
    inputText = "";
    cursorPosition = 0;
    syntaxVal = true;
    clearCircuits();
    processResult = logic::ProcessResult::empty();
}

void AppState::pushHistory(const std::string& expr) {
    if (expr.empty()) return;
    if (historyIndex >= 0 && historyIndex < static_cast<int>(history.size()) && history[historyIndex] == expr) {
        return;
    }
    while (static_cast<int>(history.size()) > historyIndex + 1) {
        history.pop_back();
    }
    history.push_back(expr);
    if (history.size() > MAX_HISTORY) {
        history.erase(history.begin());
    }
    historyIndex = static_cast<int>(history.size()) - 1;
}

bool AppState::canUndo() const {
    return historyIndex > 0;
}

bool AppState::canRedo() const {
    return historyIndex < static_cast<int>(history.size()) - 1;
}

void AppState::undo() {
    if (canUndo()) {
        historyIndex--;
        std::string expr = history[historyIndex];
        setInputText(expr);
        doProcess(false);
    }
}

void AppState::redo() {
    if (canRedo()) {
        historyIndex++;
        std::string expr = history[historyIndex];
        setInputText(expr);
        doProcess(false);
    }
}

bool AppState::doProcess(bool recordHistory, bool runProof) {
    if (inputText.empty()) {
        clearCircuits();
        processResult = logic::ProcessResult::empty();
        inputFeedback = "";
        lastProcessedExpression = inputText;
        syntaxVal = true;
        return true;
    }

    try {
        if (!logic::ExpressionProcessor::isValidSyntax(inputText)) {
            lastProcessedExpression = inputText;
            syntaxVal = false;
            return false;
        }

        logic::ProcessResult result = logic::ExpressionProcessor::process(inputText, runProof);
        if (result.isValid()) {
            processResult = result;
            syntaxVal = true;
            inputFeedback = "";
            clearCircuits();
            selectedSolutionIndex = 0;
            lastProcessedExpression = inputText;
            if (recordHistory) {
                pushHistory(inputText);
            }
            if (result.isKmapCommand()) {
                currentView = ViewMode::KMAP;
            }
            return true;
        }
    } catch (const std::exception& e) {
        inputFeedback = e.what();
        inputFeedbackFrames = 180;
    }

    return false;
}

bool AppState::hasInputChanged() const {
    return inputText != lastProcessedExpression;
}

bool AppState::processInput(bool runProof) {
    return doProcess(true, runProof);
}

void AppState::setProcessResult(const logic::ProcessResult& result) {
    processResult = result;
}

void AppState::setInputFeedback(const std::string& feedback, int frames) {
    inputFeedback = feedback;
    inputFeedbackFrames = frames;
}

void AppState::decrementFeedbackFrames() {
    if (inputFeedbackFrames > 0) {
        inputFeedbackFrames--;
    }
}

bool AppState::hasFeedback() const {
    return inputFeedbackFrames > 0 && !inputFeedback.empty();
}

void AppState::clearCircuits() {
    originalCircuit = nullptr;
    simplifiedCircuit = nullptr;
    hasProcessedCircuit = false;
}

void AppState::ensureCircuitsBuilt() {
    if (hasProcessedCircuit) return;

    originalCircuit = circuit::CircuitBuilder::fromPostfix(processResult.getOriginalPostfix());

    bool sop = isSopMode;
    std::vector<std::string> terms = sop
        ? processResult.getSimplifiedTerms()
        : processResult.getSimplifiedTermsPOS();
    
    simplifiedCircuit = circuit::CircuitBuilder::fromSimplifiedTerms(
        terms, processResult.getVariables(), !sop);

    std::string simplifiedExpr = getSelectedSimplifiedExpression();
    if (!simplifiedExpr.empty()) {
        try {
            logic::ProcessResult reparse = logic::ExpressionProcessor::process(simplifiedExpr);
            if (!reparse.getOriginalPostfix().empty()) {
                simplifiedCircuit = circuit::CircuitBuilder::fromPostfix(reparse.getOriginalPostfix());
            }
        } catch (...) {}
    }

    hasProcessedCircuit = true;
}

void AppState::setCurrentView(ViewMode view) {
    currentView = view;
}

bool AppState::isSyntaxValid() const {
    if (inputText.empty()) return true;
    return syntaxVal;
}

std::string AppState::getSimplifiedExpression() const {
    if (isSopMode) {
        return processResult.getSimplifiedExpression();
    }
    return processResult.getSimplifiedExpressionPOS();
}

std::string AppState::getSelectedSimplifiedExpression() const {
    std::vector<std::string> sols = getAllSolutions();
    if (selectedSolutionIndex >= 0 && selectedSolutionIndex < sols.size()) {
        return sols[selectedSolutionIndex];
    }
    return getSimplifiedExpression();
}

std::vector<std::string> AppState::getAllSolutions() const {
    if (isSopMode) {
        return processResult.getAllSolutions();
    }
    return processResult.getAllSolutionsPOS();
}

bool AppState::hasValidResult() const {
    return processResult.hasVariables();
}

void AppState::markAsProcessed() {
    lastProcessedExpression = inputText;
}

} // namespace com::mantiq::app
