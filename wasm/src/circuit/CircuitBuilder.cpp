#include "CircuitBuilder.h"
#include <algorithm>
#include <cctype>

namespace com::mantiq::circuit {

CircuitNodePtr CircuitBuilder::fromPostfix(const std::vector<std::string>& postfix) {
    if (postfix.empty()) {
        return nullptr;
    }

    std::vector<CircuitNodePtr> stack;

    for (const auto& token : postfix) {
        if (isVariable(token)) {
            stack.push_back(std::make_shared<CircuitNode>(token));
        } else if (isNot(token)) {
            if (stack.empty())
                return nullptr;
            CircuitNodePtr notGate = std::make_shared<CircuitNode>(NodeType::NOT);
            notGate->addChild(stack.back());
            stack.pop_back();
            stack.push_back(notGate);
        } else if (isBinaryOperator(token)) {
            if (stack.size() < 2)
                return nullptr;

            CircuitNodePtr right = stack.back(); stack.pop_back();
            CircuitNodePtr left = stack.back(); stack.pop_back();

            CircuitNodePtr gate = createGateForOperator(token, left, right);
            if (gate != nullptr) {
                stack.push_back(gate);
            }
        }
    }

    if (!stack.empty()) {
        collapseIdenticalGates(stack.back());
        return stack.back();
    }
    return nullptr;
}

CircuitNodePtr CircuitBuilder::fromSimplifiedTerms(const std::vector<std::string>& terms, const std::vector<std::string>& variables, bool isPOS) {
    if (terms.empty()) {
        return nullptr;
    }

    std::vector<CircuitNodePtr> termNodes;
    for (const auto& binary : terms) {
        CircuitNodePtr termNode = buildTermNode(binary, variables, isPOS);
        if (termNode != nullptr) {
            termNodes.push_back(termNode);
        }
    }

    if (termNodes.empty()) {
        return nullptr;
    }

    if (termNodes.size() == 1) {
        collapseIdenticalGates(termNodes[0]);
        return termNodes[0];
    }

    NodeType rootType = isPOS ? NodeType::AND : NodeType::OR;
    CircuitNodePtr root = std::make_shared<CircuitNode>(rootType);
    for (const auto& term : termNodes) {
        root->addChild(term);
    }

    collapseIdenticalGates(root);
    return root;
}

bool CircuitBuilder::isVariable(const std::string& token) {
    return !token.empty() && std::isalnum(static_cast<unsigned char>(token[0]));
}

bool CircuitBuilder::isNot(const std::string& token) {
    return token == "!" || token == "'";
}

bool CircuitBuilder::isBinaryOperator(const std::string& token) {
    return token == "&" || token == "|" || token == "@" || token == "^" || token == "=";
}

CircuitNodePtr CircuitBuilder::createGateForOperator(const std::string& operatorStr, const CircuitNodePtr& left, const CircuitNodePtr& right) {
    CircuitNodePtr gate = nullptr;

    if (operatorStr == "&") {
        gate = std::make_shared<CircuitNode>(NodeType::AND);
        gate->addChild(left);
        gate->addChild(right);
    } else if (operatorStr == "|") {
        gate = std::make_shared<CircuitNode>(NodeType::OR);
        gate->addChild(left);
        gate->addChild(right);
    } else if (operatorStr == "@") { // IMPLIES: A @ B = !A | B
        CircuitNodePtr notGate = std::make_shared<CircuitNode>(NodeType::NOT);
        notGate->addChild(left);
        gate = std::make_shared<CircuitNode>(NodeType::OR);
        gate->addChild(notGate);
        gate->addChild(right);
    } else if (operatorStr == "=") { // EQUIVALENCE: A = B = (A & B) | (!A & !B)
        CircuitNodePtr leftClone = cloneNode(left);
        CircuitNodePtr rightClone = cloneNode(right);

        CircuitNodePtr andLeftRight = std::make_shared<CircuitNode>(NodeType::AND);
        andLeftRight->addChild(left);
        andLeftRight->addChild(right);

        CircuitNodePtr notLeft = std::make_shared<CircuitNode>(NodeType::NOT);
        notLeft->addChild(leftClone);

        CircuitNodePtr notRight = std::make_shared<CircuitNode>(NodeType::NOT);
        notRight->addChild(rightClone);

        CircuitNodePtr andNotLeftNotRight = std::make_shared<CircuitNode>(NodeType::AND);
        andNotLeftNotRight->addChild(notLeft);
        andNotLeftNotRight->addChild(notRight);

        gate = std::make_shared<CircuitNode>(NodeType::OR);
        gate->addChild(andLeftRight);
        gate->addChild(andNotLeftNotRight);
    } else if (operatorStr == "^") { // XOR: A ^ B = (A & !B) | (!A & B)
        CircuitNodePtr leftClone = cloneNode(left);
        CircuitNodePtr rightClone = cloneNode(right);

        CircuitNodePtr notLeft = std::make_shared<CircuitNode>(NodeType::NOT);
        notLeft->addChild(leftClone);

        CircuitNodePtr notRight = std::make_shared<CircuitNode>(NodeType::NOT);
        notRight->addChild(rightClone);

        CircuitNodePtr andLeft = std::make_shared<CircuitNode>(NodeType::AND);
        andLeft->addChild(left);
        andLeft->addChild(notRight);

        CircuitNodePtr andRight = std::make_shared<CircuitNode>(NodeType::AND);
        andRight->addChild(notLeft);
        andRight->addChild(right);

        gate = std::make_shared<CircuitNode>(NodeType::OR);
        gate->addChild(andLeft);
        gate->addChild(andRight);
    }

    return gate;
}

CircuitNodePtr CircuitBuilder::buildTermNode(const std::string& binary, const std::vector<std::string>& variables, bool isPOS) {
    std::vector<CircuitNodePtr> literals;

    for (size_t i = 0; i < binary.length() && i < variables.size(); i++) {
        char bit = binary[i];
        if (bit == '-')
            continue;

        CircuitNodePtr varNode = std::make_shared<CircuitNode>(variables[i]);
        bool needsNot = isPOS ? (bit == '1') : (bit == '0');

        if (needsNot) {
            CircuitNodePtr notGate = std::make_shared<CircuitNode>(NodeType::NOT);
            notGate->addChild(varNode);
            literals.push_back(notGate);
        } else {
            literals.push_back(varNode);
        }
    }

    if (literals.empty()) {
        return std::make_shared<CircuitNode>(isPOS ? "0" : "1");
    }

    if (literals.size() == 1) {
        return literals[0];
    }

    NodeType gateType = isPOS ? NodeType::OR : NodeType::AND;
    CircuitNodePtr gate = std::make_shared<CircuitNode>(gateType);
    for (const auto& literal : literals) {
        gate->addChild(literal);
    }

    return gate;
}

CircuitNodePtr CircuitBuilder::cloneNode(const CircuitNodePtr& node) {
    if (node == nullptr)
        return nullptr;

    CircuitNodePtr cloneNodePtr;
    if (node->isVariable()) {
        cloneNodePtr = std::make_shared<CircuitNode>(node->getValue());
    } else {
        cloneNodePtr = std::make_shared<CircuitNode>(node->getType());
    }

    for (const auto& child : node->getChildren()) {
        cloneNodePtr->addChild(cloneNode(child));
    }

    return cloneNodePtr;
}

void CircuitBuilder::collapseIdenticalGates(const CircuitNodePtr& node) {
    if (!node) return;

    for (const auto& child : node->getChildren()) {
        collapseIdenticalGates(child);
    }

    if (node->isGate() && (node->getType() == NodeType::AND || node->getType() == NodeType::OR)) {
        std::vector<CircuitNodePtr> newChildren;
        const auto& originalChildren = node->getChildren();
        for (size_t idx = 0; idx < originalChildren.size(); idx++) {
            const auto& child = originalChildren[idx];
            if (child->isGate() && child->getType() == node->getType()) {
                size_t remaining = originalChildren.size() - 1 - idx;
                if (newChildren.size() + child->getChildren().size() + remaining <= 4) {
                    for (const auto& grandChild : child->getChildren()) {
                        newChildren.push_back(grandChild);
                    }
                    continue;
                }
            }
            newChildren.push_back(child);
        }
        node->clearChildren();
        for (const auto& child : newChildren) {
            node->addChild(child);
        }
    }
}

} // namespace com::mantiq::circuit
