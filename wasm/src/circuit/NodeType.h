#pragma once
#include <string>
#include <vector>

namespace com::mantiq::circuit {

enum class NodeType {
    AND,
    OR,
    NOT,
    VARIABLE
};

inline bool isGate(NodeType type) {
    return type == NodeType::AND || type == NodeType::OR || type == NodeType::NOT;
}

inline bool evaluateNodeType(NodeType type, const std::vector<bool>& inputs) {
    if (type == NodeType::AND) {
        if (inputs.empty()) return false;
        for (bool b : inputs) if (!b) return false;
        return true;
    } else if (type == NodeType::OR) {
        for (bool b : inputs) if (b) return true;
        return false;
    } else if (type == NodeType::NOT) {
        if (inputs.empty()) return true;
        return !inputs[0];
    }
    return false;
}

inline std::string verilogGate(NodeType type) {
    if (type == NodeType::AND) return "and";
    if (type == NodeType::OR) return "or";
    if (type == NodeType::NOT) return "not";
    return "buf";
}

inline std::string verilogOperator(NodeType type) {
    if (type == NodeType::AND) return "&";
    if (type == NodeType::OR) return "|";
    if (type == NodeType::NOT) return "~";
    return "";
}

} // namespace com::mantiq::circuit
