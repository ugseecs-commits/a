#include "ProcessResult.h"

namespace com::mantiq::logic {

ProcessResult::ProcessResult(const Builder& builder)
    : variables(builder._variables),
      originalPostfix(builder._originalPostfix),
      simplifiedTerms(builder._simplifiedTerms),
      simplifiedTermsPOS(builder._simplifiedTermsPOS),
      minterms(builder._minterms),
      dontCares(builder._dontCares),
      isKmapCmd(builder._isKmapCommand),
      alwaysTr(builder._alwaysTrue),
      alwaysFl(builder._alwaysFalse),
      simplifiedExpr(builder._simplifiedExpression),
      simplifiedExprPOS(builder._simplifiedExpressionPOS),
      stepsL(builder._stepsLog),
      allSols(builder._allSolutions),
      allSolsPOS(builder._allSolutionsPOS),
      allRawSols(builder._allRawSolutions),
      allRawSolsPOS(builder._allRawSolutionsPOS),
      primeImpls(builder._primeImpls),
      essentialPrimeImpls(builder._essentialPrimeImpls),
      primeImplsPOS(builder._primeImplsPOS),
      essentialPrimeImplsPOS(builder._essentialPrimeImplsPOS) {}

ProcessResult ProcessResult::empty() {
    return Builder().build();
}

ProcessResult::Builder ProcessResult::builder() {
    return Builder();
}

} // namespace com::mantiq::logic
