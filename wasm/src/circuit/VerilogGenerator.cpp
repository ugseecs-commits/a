#include "VerilogGenerator.h"
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cmath>

namespace com::mantiq::circuit {

static std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string VerilogGenerator::generateGateLevel(const CircuitNodePtr& root, const std::vector<std::string>& variables, const std::string& constantOutput, bool addTestbench) {
    if (variables.empty()) {
        return "// No circuit to generate";
    }

    std::stringstream sb;
    sb << "// Implementation\n";
    sb << "module logic_function(out";
    for (const auto& var : variables) {
        sb << ", " << toLower(var);
    }
    sb << ");\n";

    sb << "input ";
    for (size_t i = 0; i < variables.size(); i++) {
        if (i > 0)
            sb << ", ";
        sb << toLower(variables[i]);
    }
    sb << ";\n";

    sb << "output out;\n\n";

    if (!constantOutput.empty()) {
        std::string value = (constantOutput == "1") ? "1'b1" : "1'b0";
        sb << "buf g1(out, " << value << ");\n";
        sb << "endmodule\n";
        if (addTestbench) {
            sb << "\n" << generateTestbench(variables);
        }
        return sb.str();
    }

    if (root == nullptr) {
        return "// No circuit to generate";
    }

    std::vector<GateInfo> gates;
    std::set<std::string> wires;
    int wireCounter = 1;
    int gateCounter = 1;

    std::string outputWire = traverseAndBuildGates(root, gates, wires, wireCounter, gateCounter, variables, true);

    if (gates.empty() && outputWire != "out") {
        GateInfo bufGate = GateInfo::builder()
            .gateType("buf")
            .name("g1")
            .output("out")
            .addInput(outputWire)
            .build();
        gates.push_back(bufGate);
        outputWire = "out";
    }

    if (!wires.empty()) {
        sb << "wire ";
        int count = 0;
        for (const auto& wire : wires) {
            if (count > 0)
                sb << ", ";
            sb << wire;
            count++;
        }
        sb << ";\n\n";
    }

    for (const auto& gate : gates) {
        sb << gate.getGateType() << " " << gate.getName() << "(";
        sb << gate.getOutput();
        for (const auto& input : gate.getInputs()) {
            sb << ", " << input;
        }
        sb << ");\n";
    }

    sb << "endmodule\n";
    if (addTestbench) {
        sb << "\n" << generateTestbench(variables);
    }

    return sb.str();
}

std::string VerilogGenerator::generateDataflow(const CircuitNodePtr& root, const std::vector<std::string>& variables, const std::string& constantOutput, bool addTestbench) {
    if (variables.empty()) {
        return "// No circuit to generate";
    }

    std::stringstream sb;
    sb << "// Implementation (Dataflow)\n";
    sb << "module logic_function(out";
    for (const auto& var : variables) {
        sb << ", " << toLower(var);
    }
    sb << ");\n";

    sb << "input ";
    for (size_t i = 0; i < variables.size(); i++) {
        if (i > 0)
            sb << ", ";
        sb << toLower(variables[i]);
    }
    sb << ";\n";

    sb << "output out;\n\n";

    if (!constantOutput.empty()) {
        std::string value = (constantOutput == "1") ? "1'b1" : "1'b0";
        sb << "assign out = " << value << ";\n";
        sb << "endmodule\n";
        if (addTestbench) {
            sb << "\n" << generateTestbench(variables);
        }
        return sb.str();
    }

    if (root == nullptr) {
        return "// No circuit to generate";
    }

    std::string expression = generateExpression(root, variables);
    sb << "assign out = " << expression << ";\n";
    sb << "endmodule\n";

    if (addTestbench) {
        sb << "\n" << generateTestbench(variables);
    }

    return sb.str();
}

std::string VerilogGenerator::traverseAndBuildGates(
    const CircuitNodePtr& node,
    std::vector<GateInfo>& gates,
    std::set<std::string>& wires,
    int& wireCounter,
    int& gateCounter,
    const std::vector<std::string>& variables,
    bool isRoot
) {
    if (node == nullptr)
        return "1'b0";

    if (node->isVariable()) {
        return toLower(node->getValue());
    }

    const auto& children = node->getChildren();
    if (children.empty())
        return "1'b0";

    std::vector<std::string> childOutputs;
    for (const auto& child : children) {
        std::string childOut = traverseAndBuildGates(child, gates, wires, wireCounter, gateCounter, variables, false);
        childOutputs.push_back(childOut);
    }

    std::string gType = verilogGate(node->getType());
    if (!circuit::isGate(node->getType())) {
        return childOutputs.empty() ? "1'b0" : childOutputs[0];
    }

    if (node->getType() == NodeType::NOT) {
        std::string outputWire;
        if (isRoot) {
            outputWire = "out";
        } else {
            outputWire = "w" + std::to_string(wireCounter++);
            wires.insert(outputWire);
        }

        GateInfo gate = GateInfo::builder()
            .gateType(gType)
            .name("g" + std::to_string(gateCounter++))
            .output(outputWire)
            .addInput(childOutputs[0])
            .build();
        gates.push_back(gate);

        return outputWire;
    }

    if (childOutputs.size() == 1) {
        if (isRoot) {
            GateInfo bufGate = GateInfo::builder()
                .gateType("buf")
                .name("g" + std::to_string(gateCounter++))
                .output("out")
                .addInput(childOutputs[0])
                .build();
            gates.push_back(bufGate);
            return "out";
        }
        return childOutputs[0];
    }

    std::string currentOutput = childOutputs[0];

    for (size_t i = 1; i < childOutputs.size(); i++) {
        std::string outputWire;
        bool isLastInCascade = (i == childOutputs.size() - 1);

        if (isLastInCascade && isRoot) {
            outputWire = "out";
        } else {
            outputWire = "w" + std::to_string(wireCounter++);
            wires.insert(outputWire);
        }

        GateInfo gate = GateInfo::builder()
            .gateType(gType)
            .name("g" + std::to_string(gateCounter++))
            .output(outputWire)
            .addInput(currentOutput)
            .addInput(childOutputs[i])
            .build();
        gates.push_back(gate);

        currentOutput = outputWire;
    }

    return currentOutput;
}

static void collectFlatChildren(const com::mantiq::circuit::CircuitNodePtr& node, com::mantiq::circuit::NodeType parentType, std::vector<com::mantiq::circuit::CircuitNodePtr>& flatChildren) {
    if (node && node->getType() == parentType && (parentType == com::mantiq::circuit::NodeType::AND || parentType == com::mantiq::circuit::NodeType::OR)) {
        for (const auto& child : node->getChildren()) {
            collectFlatChildren(child, parentType, flatChildren);
        }
    } else if (node) {
        flatChildren.push_back(node);
    }
}

std::string VerilogGenerator::generateExpression(const CircuitNodePtr& node, const std::vector<std::string>& variables) {
    if (node == nullptr)
        return "1'b0";

    if (node->isVariable()) {
        return toLower(node->getValue());
    }

    const auto& children = node->getChildren();
    if (children.empty())
        return "1'b0";

    NodeType type = node->getType();
    std::string op = verilogOperator(type);

    if (type == NodeType::NOT) {
        return op + generateExpression(children[0], variables);
    }

    if (circuit::isGate(type)) {
        if (children.size() == 1) {
            return generateExpression(children[0], variables);
        }
        
        std::vector<CircuitNodePtr> flatChildren;
        if (type == NodeType::AND || type == NodeType::OR) {
            collectFlatChildren(node, type, flatChildren);
        } else {
            flatChildren = children;
        }

        std::stringstream sb;
        sb << "(";
        for (size_t i = 0; i < flatChildren.size(); i++) {
            if (i > 0)
                sb << " " << op << " ";
            sb << generateExpression(flatChildren[i], variables);
        }
        sb << ")";
        return sb.str();
    }

    return "1'b0";
}

std::string VerilogGenerator::generateTestbench(const std::vector<std::string>& variables) {
    std::stringstream sb;
    sb << "// Testbench\n";
    sb << "module testbench;\n";

    sb << "reg ";
    for (size_t i = 0; i < variables.size(); i++) {
        if (i > 0)
            sb << ", ";
        sb << toLower(variables[i]);
    }
    sb << ";\n";

    sb << "wire out;\n\n";

    sb << "logic_function test(out";
    for (const auto& var : variables) {
        sb << ", " << toLower(var);
    }
    sb << ");\n\n";

    sb << "initial\nbegin\n";

    int numCombinations = static_cast<int>(std::pow(2, variables.size()));
    for (int i = 0; i < numCombinations; i++) {
        sb << "    #100 ";
        for (size_t v = 0; v < variables.size(); v++) {
            if (v > 0)
                sb << " ";
            int bitValue = (i >> (variables.size() - 1 - v)) & 1;
            sb << toLower(variables[v]) << " = 1'b" << bitValue << ";";
        }
        sb << "\n";
    }

    sb << "end\n";
    sb << "endmodule\n";

    return sb.str();
}

} // namespace com::mantiq::circuit
