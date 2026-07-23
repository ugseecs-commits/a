#pragma once
#include "CircuitNode.h"
#include "GateInfo.h"
#include <string>
#include <vector>
#include <set>

namespace com::mantiq::circuit {

class VerilogGenerator {
private:
    static std::string traverseAndBuildGates(
        const CircuitNodePtr& node,
        std::vector<GateInfo>& gates,
        std::set<std::string>& wires,
        int& wireCounter,
        int& gateCounter,
        const std::vector<std::string>& variables,
        bool isRoot
    );

    static std::string generateExpression(const CircuitNodePtr& node, const std::vector<std::string>& variables);
    static std::string generateTestbench(const std::vector<std::string>& variables);

public:
    static std::string generateGateLevel(const CircuitNodePtr& root, const std::vector<std::string>& variables, const std::string& constantOutput = "", bool addTestbench = true);
    static std::string generateDataflow(const CircuitNodePtr& root, const std::vector<std::string>& variables, const std::string& constantOutput = "", bool addTestbench = true);
};

} // namespace com::mantiq::circuit
