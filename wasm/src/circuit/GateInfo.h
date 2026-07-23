#pragma once
#include <string>
#include <vector>

namespace com::mantiq::circuit {

class GateInfo {
private:
    std::string gateType;
    std::string name;
    std::string output;
    std::vector<std::string> inputs;

public:
    class Builder;

    GateInfo() = default;
    GateInfo(const std::string& type, const std::string& name, const std::string& out, const std::vector<std::string>& ins)
        : gateType(type), name(name), output(out), inputs(ins) {}

    const std::string& getGateType() const { return gateType; }
    const std::string& getName() const { return name; }
    const std::string& getOutput() const { return output; }
    const std::vector<std::string>& getInputs() const { return inputs; }

    static Builder builder();

    class Builder {
    private:
        std::string _gateType = "";
        std::string _name = "";
        std::string _output = "";
        std::vector<std::string> _inputs;

    public:
        Builder() = default;

        Builder& gateType(const std::string& type) {
            _gateType = type;
            return *this;
        }

        Builder& name(const std::string& n) {
            _name = n;
            return *this;
        }

        Builder& output(const std::string& out) {
            _output = out;
            return *this;
        }

        Builder& addInput(const std::string& input) {
            _inputs.push_back(input);
            return *this;
        }

        Builder& inputs(const std::vector<std::string>& ins) {
            _inputs = ins;
            return *this;
        }

        GateInfo build() const {
            return GateInfo(_gateType, _name, _output, _inputs);
        }
    };
};

inline GateInfo::Builder GateInfo::builder() {
    return GateInfo::Builder();
}

} // namespace com::mantiq::circuit
