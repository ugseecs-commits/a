#pragma once
#include "ViewMode.h"
#include "../logic/ProcessResult.h"
#include "../circuit/CircuitNode.h"
#include <string>
#include <vector>

namespace com::mantiq::app {

class AppState {
private:
    // History state
    std::vector<std::string> history;
    int historyIndex = -1;
    static constexpr int MAX_HISTORY = 50;

    // Expression state
    std::string inputText = "";
    int cursorPosition = 0;
    std::string lastProcessedExpression = "";
    logic::ProcessResult processResult;
    std::string inputFeedback = "";
    int inputFeedbackFrames = 0;

    // Circuit state
    circuit::CircuitNodePtr originalCircuit = nullptr;
    circuit::CircuitNodePtr simplifiedCircuit = nullptr;
    bool hasProcessedCircuit = false;
    int selectedSolutionIndex = 0;

    // View state
    ViewMode currentView = ViewMode::SIMULATION;
    bool isSopMode = true;
    bool inputBoxAct = true;
    bool syntaxVal = true;

    void pushHistory(const std::string& expr);
    bool doProcess(bool recordHistory, bool runProof = true);

public:
    AppState();

    const std::string& getInputText() const { return inputText; }
    void setInputText(const std::string& text);

    int getCursorPosition() const { return cursorPosition; }
    void setCursorPosition(int pos);

    void moveCursorLeft();
    void moveCursorRight();
    void moveCursorToStart();
    void moveCursorToEnd();

    void appendToInput(char c);
    void insertTextAtCursor(const std::string& text);
    void deleteLastChar();
    void deleteNextChar();
    void clearInput();

    bool canUndo() const;
    bool canRedo() const;
    void undo();
    void redo();

    bool hasInputChanged() const;
    bool processInput(bool runProof = true);

    logic::ProcessResult getProcessResult() const { return processResult; }
    void setProcessResult(const logic::ProcessResult& result);

    const std::string& getInputFeedback() const { return inputFeedback; }
    void setInputFeedback(const std::string& feedback, int frames);
    int getInputFeedbackFrames() const { return inputFeedbackFrames; }
    void decrementFeedbackFrames();
    bool hasFeedback() const;

    circuit::CircuitNodePtr getOriginalCircuit() const { return originalCircuit; }
    void setOriginalCircuit(const circuit::CircuitNodePtr& circuit) { originalCircuit = circuit; }

    circuit::CircuitNodePtr getSimplifiedCircuit() const { return simplifiedCircuit; }
    void setSimplifiedCircuit(const circuit::CircuitNodePtr& circuit) { simplifiedCircuit = circuit; }

    bool hasProcessed() const { return hasProcessedCircuit; }
    void setHasProcessed(bool processed) { hasProcessedCircuit = processed; }
    void clearCircuits();
    void ensureCircuitsBuilt();

    ViewMode getCurrentView() const { return currentView; }
    void setCurrentView(ViewMode view);

    bool isSOP() const { return isSopMode; }
    void setSOP(bool sop) { isSopMode = sop; }
    void toggleSOP() { isSopMode = !isSopMode; }

    bool isInputBoxActive() const { return inputBoxAct; }
    void setInputBoxActive(bool active) { inputBoxAct = active; }

    bool isSyntaxValid() const;
    std::string getSimplifiedExpression() const;
    std::string getSelectedSimplifiedExpression() const;
    std::vector<std::string> getAllSolutions() const;
    bool hasValidResult() const;

    int getSelectedSolutionIndex() const { return selectedSolutionIndex; }
    void setSelectedSolutionIndex(int index) { 
        selectedSolutionIndex = index; 
        clearCircuits(); 
    }
    void markAsProcessed();
};

} // namespace com::mantiq::app
