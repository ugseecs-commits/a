#pragma once
#include "NodeType.h"
#include <string>
#include <vector>
#include <memory>

namespace com::mantiq::circuit {

class CircuitNode;
using CircuitNodePtr = std::shared_ptr<CircuitNode>;

class CircuitNode : public std::enable_shared_from_this<CircuitNode> {
private:
    NodeType type;
    std::string value;
    std::vector<CircuitNodePtr> children;

    // Layout properties
    float x = 0.0f;
    float y = 0.0f;
    int depth = 0;
    float subtreeWidth = 0.0f;
    float scale = 1.0f;

    // Interactive state
    bool on = false;

public:
    CircuitNode(const std::string& variableName);
    CircuitNode(NodeType gateType);

    NodeType getType() const { return type; }
    const std::string& getValue() const { return value; }
    bool isVariable() const { return type == NodeType::VARIABLE; }
    bool isGate() const { return circuit::isGate(type); }
    bool isLeaf() const { return children.empty(); }

    const std::vector<CircuitNodePtr>& getChildren() const { return children; }
    void addChild(const CircuitNodePtr& child);
    void clearChildren() { children.clear(); }

    float getX() const { return x; }
    void setX(float val) { x = val; }
    float getY() const { return y; }
    void setY(float val) { y = val; }
    void translate(float dx, float dy) { x += dx; y += dy; }

    int getDepth() const { return depth; }
    void setDepth(int val) { depth = val; }
    float getSubtreeWidth() const { return subtreeWidth; }
    void setSubtreeWidth(float val) { subtreeWidth = val; }
    float getScale() const { return scale; }
    void setScale(float val) { scale = val; }
    void multiplyScale(float factor) { scale *= factor; }

    bool isOn() const { return on; }
    void setOn(bool val) { on = val; }
    void toggle() { on = !on; }

    std::string toString() const;
};

} // namespace com::mantiq::circuit
