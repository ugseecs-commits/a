#pragma once
#include "CircuitNode.h"
#include <vector>
#include <string>

namespace com::mantiq::circuit {

class CircuitBuilder {
private:
    static bool isVariable(const std::string& token);
    static bool isNot(const std::string& token);
    static bool isBinaryOperator(const std::string& token);
    static CircuitNodePtr createGateForOperator(const std::string& operatorStr, const CircuitNodePtr& left, const CircuitNodePtr& right);
    static CircuitNodePtr buildTermNode(const std::string& binary, const std::vector<std::string>& variables, bool isPOS);
    static CircuitNodePtr cloneNode(const CircuitNodePtr& node);
    static void collapseIdenticalGates(const CircuitNodePtr& node);

public:
    static CircuitNodePtr fromPostfix(const std::vector<std::string>& postfix);
    static CircuitNodePtr fromSimplifiedTerms(const std::vector<std::string>& terms, const std::vector<std::string>& variables, bool isPOS);
};

} // namespace com::mantiq::circuit
