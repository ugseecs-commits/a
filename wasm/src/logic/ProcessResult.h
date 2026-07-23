#pragma once
#include <string>
#include <vector>

namespace com::mantiq::logic {

class ProcessResult {
private:
    std::vector<std::string> variables;
    std::vector<std::string> originalPostfix;
    std::vector<std::string> simplifiedTerms;
    std::vector<std::string> simplifiedTermsPOS;
    std::vector<int> minterms;
    std::vector<int> dontCares;
    bool isKmapCmd = false;
    bool alwaysTr = false;
    bool alwaysFl = false;
    std::string simplifiedExpr;
    std::string simplifiedExprPOS;
    std::string stepsL;
    std::vector<std::string> allSols;
    std::vector<std::string> allSolsPOS;
    std::vector<std::vector<std::string>> allRawSols;
    std::vector<std::vector<std::string>> allRawSolsPOS;
    std::vector<std::string> primeImpls;
    std::vector<std::string> essentialPrimeImpls;
    std::vector<std::string> primeImplsPOS;
    std::vector<std::string> essentialPrimeImplsPOS;

public:
    class Builder;

    ProcessResult() = default;
    ProcessResult(const Builder& builder);

    const std::vector<std::string>& getVariables() const { return variables; }
    const std::vector<std::string>& getOriginalPostfix() const { return originalPostfix; }
    const std::vector<std::string>& getSimplifiedTerms() const { return simplifiedTerms; }
    const std::vector<std::string>& getSimplifiedTermsPOS() const { return simplifiedTermsPOS; }
    const std::vector<int>& getMinterms() const { return minterms; }
    const std::vector<int>& getDontCares() const { return dontCares; }
    bool isKmapCommand() const { return isKmapCmd; }
    bool isAlwaysTrue() const { return alwaysTr; }
    bool isAlwaysFalse() const { return alwaysFl; }
    const std::string& getSimplifiedExpression() const { return simplifiedExpr; }
    const std::string& getSimplifiedExpressionPOS() const { return simplifiedExprPOS; }
    const std::vector<std::string>& getAllSolutions() const { return allSols; }
    const std::vector<std::string>& getAllSolutionsPOS() const { return allSolsPOS; }
    const std::vector<std::vector<std::string>>& getAllRawSolutions() const { return allRawSols; }
    const std::vector<std::vector<std::string>>& getAllRawSolutionsPOS() const { return allRawSolsPOS; }
    const std::vector<std::string>& getPrimeImplicants() const { return primeImpls; }
    const std::vector<std::string>& getEssentialPrimeImplicants() const { return essentialPrimeImpls; }
    const std::vector<std::string>& getPrimeImplicantsPOS() const { return primeImplsPOS; }
    const std::vector<std::string>& getEssentialPrimeImplicantsPOS() const { return essentialPrimeImplsPOS; }
    const std::string& getStepsLog() const { return stepsL; }

    bool isValid() const { return !originalPostfix.empty() || isKmapCmd; }
    bool hasVariables() const { return !variables.empty(); }

    static ProcessResult empty();
    static Builder builder();

    class Builder {
    public:
        std::vector<std::string> _variables;
        std::vector<std::string> _originalPostfix;
        std::vector<std::string> _simplifiedTerms;
        std::vector<std::string> _simplifiedTermsPOS;
        std::vector<int> _minterms;
        std::vector<int> _dontCares;
        bool _isKmapCommand = false;
        bool _alwaysTrue = false;
        bool _alwaysFalse = false;
        std::string _simplifiedExpression = "";
        std::string _simplifiedExpressionPOS = "";
        std::string _stepsLog = "";
        std::vector<std::string> _allSolutions;
        std::vector<std::string> _allSolutionsPOS;
        std::vector<std::vector<std::string>> _allRawSolutions;
        std::vector<std::vector<std::string>> _allRawSolutionsPOS;
        std::vector<std::string> _primeImpls;
        std::vector<std::string> _essentialPrimeImpls;
        std::vector<std::string> _primeImplsPOS;
        std::vector<std::string> _essentialPrimeImplsPOS;

        Builder() = default;

        Builder& variables(const std::vector<std::string>& vars) {
            _variables = vars;
            return *this;
        }

        Builder& originalPostfix(const std::vector<std::string>& postfix) {
            _originalPostfix = postfix;
            return *this;
        }

        Builder& simplifiedTerms(const std::vector<std::string>& terms) {
            _simplifiedTerms = terms;
            return *this;
        }

        Builder& simplifiedTermsPOS(const std::vector<std::string>& terms) {
            _simplifiedTermsPOS = terms;
            return *this;
        }

        Builder& minterms(const std::vector<int>& mints) {
            _minterms = mints;
            return *this;
        }

        Builder& dontCares(const std::vector<int>& dcs) {
            _dontCares = dcs;
            return *this;
        }

        Builder& isKmapCommand(bool isKmap) {
            _isKmapCommand = isKmap;
            return *this;
        }

        Builder& alwaysTrue(bool val) {
            _alwaysTrue = val;
            return *this;
        }

        Builder& alwaysFalse(bool val) {
            _alwaysFalse = val;
            return *this;
        }

        Builder& simplifiedExpression(const std::string& expr) {
            _simplifiedExpression = expr;
            return *this;
        }

        Builder& simplifiedExpressionPOS(const std::string& expr) {
            _simplifiedExpressionPOS = expr;
            return *this;
        }

        Builder& stepsLog(const std::string& log) {
            _stepsLog = log;
            return *this;
        }

        Builder& allSolutions(const std::vector<std::string>& sols) {
            _allSolutions = sols;
            return *this;
        }

        Builder& allSolutionsPOS(const std::vector<std::string>& sols) {
            _allSolutionsPOS = sols;
            return *this;
        }

        Builder& allRawSolutions(const std::vector<std::vector<std::string>>& sols) {
            _allRawSolutions = sols;
            return *this;
        }

        Builder& allRawSolutionsPOS(const std::vector<std::vector<std::string>>& sols) {
            _allRawSolutionsPOS = sols;
            return *this;
        }

        Builder& primeImplicants(const std::vector<std::string>& primeImpls) {
            _primeImpls = primeImpls;
            return *this;
        }

        Builder& essentialPrimeImplicants(const std::vector<std::string>& essentialPrimeImpls) {
            _essentialPrimeImpls = essentialPrimeImpls;
            return *this;
        }

        Builder& primeImplicantsPOS(const std::vector<std::string>& primeImplsPOS) {
            _primeImplsPOS = primeImplsPOS;
            return *this;
        }

        Builder& essentialPrimeImplicantsPOS(const std::vector<std::string>& essentialPrimeImplsPOS) {
            _essentialPrimeImplsPOS = essentialPrimeImplsPOS;
            return *this;
        }

        ProcessResult build() const {
            return ProcessResult(*this);
        }
    };
};

} // namespace com::mantiq::logic
