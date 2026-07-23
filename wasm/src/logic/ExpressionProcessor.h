#pragma once
#include "ProcessResult.h"
#include <string>
#include <vector>
#include <map>

namespace com::mantiq::logic {

class ExpressionProcessor {
private:
    static ProcessResult tryParseShorthand(const std::string& expression);
    static std::vector<int> parseCommaNumbers(const std::string& str);
    static std::string normalizeExpression(const std::string& expr);
    static bool isVarChar(char c);
    static int getPrecedence(const std::string& op);
    static std::vector<std::string> tokenize(const std::string& expr);
    static std::vector<std::string> addImplicitAnd(const std::vector<std::string>& tokens);
    static std::vector<std::string> infixToPostfix(const std::vector<std::string>& tokens);
    static bool evaluatePostfix(const std::vector<std::string>& postfix, const std::map<std::string, bool>& values);
    static std::string buildSopExpression(const std::vector<std::string>& terms, const std::vector<std::string>& vars);
    static std::string buildPosExpression(const std::vector<std::string>& terms, const std::vector<std::string>& vars);

public:
    static ProcessResult process(const std::string& expression, bool runProof = false);
    static bool isValidSyntax(const std::string& expr);
    static std::string binaryToVariables(const std::string& binary, const std::vector<std::string>& vars, bool isPOS);
};

} // namespace com::mantiq::logic
