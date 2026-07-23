#include "CircuitNode.h"
#include <cstdio>

namespace com::mantiq::circuit {

CircuitNode::CircuitNode(const std::string& variableName) {
    this->type = NodeType::VARIABLE;
    this->value = variableName;
    this->scale = 1.0f;
}

CircuitNode::CircuitNode(NodeType gateType) {
    this->type = gateType;
    this->value = "";
    this->scale = 1.0f;
}

void CircuitNode::addChild(const CircuitNodePtr& child) {
    if (child != nullptr) {
        children.push_back(child);
    }
}

std::string CircuitNode::toString() const {
    std::string typeStr;
    switch (type) {
        case NodeType::AND:      typeStr = "AND"; break;
        case NodeType::OR:       typeStr = "OR"; break;
        case NodeType::NOT:      typeStr = "NOT"; break;
        case NodeType::VARIABLE: typeStr = "VARIABLE"; break;
    }
    char buf[256];
    snprintf(buf, sizeof(buf), "CircuitNode[type=%s, value=%s, children=%d]", typeStr.c_str(), value.c_str(), static_cast<int>(children.size()));
    return std::string(buf);
}

} // namespace com::mantiq::circuit
