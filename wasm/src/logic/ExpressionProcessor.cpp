#include "ExpressionProcessor.h"
#include "QuineMcCluskey.h"
#include "ASTProver.h"
#include <regex>
#include <sstream>
#include <cctype>
#include <cmath>
#include <algorithm>
#include <set>
#include <stack>
#include <stdexcept>

namespace com::mantiq::logic {

static std::string replaceString(std::string str, const std::string& from, const std::string& to) {
    size_t start_pos = 0;
    while((start_pos = str.find(from, start_pos)) != std::string::npos) {
        str.replace(start_pos, from.length(), to);
        start_pos += to.length();
    }
    return str;
}

static std::vector<std::string> split(const std::string& s, char delim) {
    std::vector<std::string> result;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, delim)) {
        size_t first = item.find_first_not_of(" \t\r\n");
        if (first != std::string::npos) {
            size_t last = item.find_last_not_of(" \t\r\n");
            result.push_back(item.substr(first, (last - first + 1)));
        } else {
            result.push_back("");
        }
    }
    return result;
}

static std::string trim(const std::string& s) {
    size_t first = s.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    size_t last = s.find_last_not_of(" \t\r\n");
    return s.substr(first, (last - first + 1));
}

struct TermLiteral {
    std::string var;
    bool complemented;
};

static std::vector<TermLiteral> parseSopTermLiterals(const std::string& termStr) {
    std::vector<TermLiteral> lits;
    std::string s = trim(termStr);
    if (s.length() >= 2 && s.front() == '(' && s.back() == ')') {
        s = s.substr(1, s.length() - 2);
    }
    for (size_t i = 0; i < s.length(); ) {
        if (std::isalnum(static_cast<unsigned char>(s[i]))) {
            std::string v(1, s[i]);
            size_t j = i + 1;
            while (j < s.length() && std::isalnum(static_cast<unsigned char>(s[j]))) {
                v += s[j];
                j++;
            }
            bool comp = false;
            if (j < s.length() && (s[j] == '\'' || s[j] == '!')) {
                comp = true;
                j++;
            }
            lits.push_back({v, comp});
            i = j;
        } else {
            i++;
        }
    }
    return lits;
}

static std::string sortLiteralsInTerm(const std::string& termStr) {
    std::string s = trim(termStr);
    bool hasParens = (s.length() >= 2 && s.front() == '(' && s.back() == ')');
    if (hasParens) s = s.substr(1, s.length() - 2);

    auto lits = parseSopTermLiterals(s);
    std::sort(lits.begin(), lits.end(), [](const TermLiteral& a, const TermLiteral& b) {
        if (a.var != b.var) return a.var < b.var;
        return !a.complemented && b.complemented;
    });

    std::stringstream sb;
    for (const auto& lit : lits) {
        sb << lit.var;
        if (lit.complemented) sb << "'";
    }
    std::string res = sb.str();
    if (hasParens) res = "(" + res + ")";
    return res;
}

static bool compareSopTerms(const std::string& a, const std::string& b) {
    if (a == b) return false;
    if (a == "0" || a == "1") return true;
    if (b == "0" || b == "1") return false;

    auto litsA = parseSopTermLiterals(a);
    auto litsB = parseSopTermLiterals(b);

    // Primary: shorter terms first (fewer literals)
    if (litsA.size() != litsB.size()) {
        return litsA.size() < litsB.size();
    }

    // Secondary: lexicographical comparison of literals
    size_t minLen = std::min(litsA.size(), litsB.size());
    for (size_t i = 0; i < minLen; i++) {
        if (litsA[i].var != litsB[i].var) {
            return litsA[i].var < litsB[i].var;
        }
        if (litsA[i].complemented != litsB[i].complemented) {
            return !litsA[i].complemented;
        }
    }
    return a < b;
}

ProcessResult ExpressionProcessor::process(const std::string& expression, bool runProof) {
    if (trim(expression).empty()) {
        return ProcessResult::empty();
    }

    ProcessResult shorthandResult = tryParseShorthand(expression);
    if (shorthandResult.isValid()) {
        return shorthandResult;
    }

    std::string normalized = normalizeExpression(expression);
    std::vector<std::string> tokens = tokenize(normalized);
    tokens = addImplicitAnd(tokens);

    // Extract variables
    std::vector<std::string> variables;
    std::set<std::string> varSet;
    for (const auto& tok : tokens) {
        if (!tok.empty() && isVarChar(tok[0]) && tok != "0" && tok != "1") {
            if (varSet.find(tok) == varSet.end()) {
                varSet.insert(tok);
                variables.push_back(tok);
            }
        }
    }

    std::sort(variables.begin(), variables.end());

    if (variables.size() > 6) {
        return ProcessResult::empty();
    }

    std::vector<std::string> postfix = infixToPostfix(tokens);
    if (postfix.empty()) {
        return ProcessResult::empty();
    }

    int numVars = static_cast<int>(variables.size());
    int rows = static_cast<int>(std::pow(2, numVars));
    std::vector<int> minterms;

    for (int i = 0; i < rows; i++) {
        std::map<std::string, bool> values;
        for (int j = 0; j < numVars; j++) {
            bool val = ((i >> (numVars - 1 - j)) & 1) == 1;
            values[variables[j]] = val;
        }
        if (evaluatePostfix(postfix, values)) {
            minterms.push_back(i);
        }
    }

    bool isAlwaysTrue = (minterms.size() == static_cast<size_t>(rows));
    bool isAlwaysFalse = minterms.empty();

    QuineMcCluskey::MinimizationResult sopResult = QuineMcCluskey::minimizeWithDetails(numVars, minterms, {});
    std::vector<std::string> simplifiedTerms = sopResult.solution;

    std::set<int> mintermSet(minterms.begin(), minterms.end());
    std::vector<int> maxterms;
    for (int i = 0; i < rows; i++) {
        if (mintermSet.find(i) == mintermSet.end()) {
            maxterms.push_back(i);
        }
    }
    QuineMcCluskey::MinimizationResult posResult = QuineMcCluskey::minimizeWithDetails(numVars, maxterms, {});
    std::vector<std::string> simplifiedTermsPOS = posResult.solution;

    std::string simplifiedExpr = buildSopExpression(simplifiedTerms, variables);
    std::string simplifiedExprPOS = buildPosExpression(simplifiedTermsPOS, variables);

    std::string algebraicStepsSOP = "";
    if (runProof && !isAlwaysTrue && !isAlwaysFalse) {
        ASTProver prover;
        std::string path = prover.generateProof(postfix, simplifiedExpr);
        if (!path.empty()) {
            algebraicStepsSOP = "\n\n=== Algebraic Proof (SOP) ===\n -- (Given) -->\n" + expression + "\n" + path;
        }
    }

    std::string algebraicStepsPOS = "";
    if (runProof && !isAlwaysTrue && !isAlwaysFalse) {
        ASTProver prover;
        std::string path = prover.generateProof(postfix, simplifiedExprPOS);
        if (!path.empty()) {
            algebraicStepsPOS = "\n\n=== Algebraic Proof (POS) ===\n -- (Given) -->\n" + expression + "\n" + path;
        }
    }


    std::string combinedLogs = "=== SOP Minimization ===\n" + sopResult.stepsLog + algebraicStepsSOP +
                               "\n\n=== POS Minimization ===\n" + posResult.stepsLog + algebraicStepsPOS;

    std::vector<std::string> allSopExprs;
    for (const auto& sol : sopResult.allSolutions) {
        allSopExprs.push_back(buildSopExpression(sol, variables));
    }
    std::sort(allSopExprs.begin(), allSopExprs.end(), compareSopTerms);
    allSopExprs.erase(std::unique(allSopExprs.begin(), allSopExprs.end()), allSopExprs.end());
    if (!allSopExprs.empty()) {
        simplifiedExpr = allSopExprs[0];
    }

    std::vector<std::string> allPosExprs;
    for (const auto& sol : posResult.allSolutions) {
        allPosExprs.push_back(buildPosExpression(sol, variables));
    }
    std::sort(allPosExprs.begin(), allPosExprs.end(), compareSopTerms);
    allPosExprs.erase(std::unique(allPosExprs.begin(), allPosExprs.end()), allPosExprs.end());
    if (!allPosExprs.empty()) {
        simplifiedExprPOS = allPosExprs[0];
    }

    return ProcessResult::builder()
        .variables(variables)
        .originalPostfix(postfix)
        .simplifiedTerms(simplifiedTerms)
        .simplifiedTermsPOS(simplifiedTermsPOS)
        .minterms(minterms)
        .dontCares({})
        .stepsLog(combinedLogs)
        .alwaysTrue(isAlwaysTrue)
        .alwaysFalse(isAlwaysFalse)
        .simplifiedExpression(simplifiedExpr)
        .simplifiedExpressionPOS(simplifiedExprPOS)
        .allSolutions(allSopExprs)
        .allSolutionsPOS(allPosExprs)
        .allRawSolutions(sopResult.allSolutions)
        .allRawSolutionsPOS(posResult.allSolutions)
        .primeImplicants(sopResult.primeImplicants)
        .essentialPrimeImplicants(sopResult.essentialPrimeImplicants)
        .primeImplicantsPOS(posResult.primeImplicants)
        .essentialPrimeImplicantsPOS(posResult.essentialPrimeImplicants)
        .build();
}

ProcessResult ExpressionProcessor::tryParseShorthand(const std::string& expression) {
    try {
        std::regex kmapPattern("^\\s*KMAP\\s*\\(([^)]+)\\)\\s*$", std::regex_constants::icase);
        std::smatch kmapMatcher;
        if (std::regex_match(expression, kmapMatcher, kmapPattern)) {
            std::string args = trim(kmapMatcher[1].str());
            std::vector<std::string> vars;
            bool isAllDigits = !args.empty() && std::all_of(args.begin(), args.end(), ::isdigit);
            if (isAllDigits) {
                int num = std::stoi(args);
                if (num < 1 || num > 6) return ProcessResult::empty();
                for (int i = 0; i < num; i++) {
                    vars.push_back(std::string(1, static_cast<char>('A' + i)));
                }
            } else {
                std::vector<std::string> parts = split(args, ',');
                for (const auto& part : parts) {
                    std::string pt = trim(part);
                    if (!pt.empty()) vars.push_back(pt);
                }
                if (vars.size() > 6) return ProcessResult::empty();
            }
            return ProcessResult::builder()
                .variables(vars)
                .isKmapCommand(true)
                .minterms({})
                .dontCares({})
                .build();
        }

        std::regex shortPattern("^\\s*(?:([a-zA-Z0-9_,'\\s]+):)?\\s*([mM])\\s*\\(([\\d,\\s]*)\\)(?:\\s*[dD]\\s*\\(([\\d,\\s]*)\\))?\\s*$");
        std::regex shortPatternOnlyDC("^\\s*(?:([a-zA-Z0-9_,'\\s]+):)?\\s*[dD]\\s*\\(([\\d,\\s]*)\\)\\s*$");
        std::smatch shortMatcher;
        
        std::string varStr = "";
        bool isPOS = false;
        std::string termsStr = "";
        std::string dcStr = "";
        bool matched = false;

        if (std::regex_match(expression, shortMatcher, shortPattern)) {
            varStr = shortMatcher[1].str();
            isPOS = shortMatcher[2].str() == "M";
            termsStr = shortMatcher[3].str();
            dcStr = shortMatcher[4].str();
            matched = true;
        } else if (std::regex_match(expression, shortMatcher, shortPatternOnlyDC)) {
            varStr = shortMatcher[1].str();
            isPOS = false;
            termsStr = "";
            dcStr = shortMatcher[2].str();
            matched = true;
        }

        if (matched) {
            std::vector<int> terms = parseCommaNumbers(termsStr);
            std::vector<int> dontCares = parseCommaNumbers(dcStr);

            int maxTerm = -1;
            for (int t : terms) if (t > maxTerm) maxTerm = t;
            for (int t : dontCares) if (t > maxTerm) maxTerm = t;

            int requiredVars = maxTerm < 0 ? 1 : static_cast<int>(std::max(1.0, std::ceil(std::log2(maxTerm + 1))));

            std::vector<std::string> vars;
            if (!varStr.empty()) {
                std::vector<std::string> parts = split(varStr, ',');
                for (const auto& part : parts) {
                    std::string trimmedVar = trim(part);
                    if (!trimmedVar.empty()) vars.push_back(trimmedVar);
                }
            } else {
                for (int i = 0; i < requiredVars; i++) {
                    vars.push_back(std::string(1, static_cast<char>('A' + i)));
                }
            }

            if (vars.size() > 6) return ProcessResult::empty();

            int numVars = static_cast<int>(vars.size());
            int rows = static_cast<int>(std::pow(2, numVars));

            for (int t : terms) {
                if (t >= rows) return ProcessResult::empty();
            }
            for (int t : dontCares) {
                if (t >= rows) return ProcessResult::empty();
            }

            std::vector<int> minterms;
            std::vector<int> maxterms;

            std::set<int> termsSet(terms.begin(), terms.end());
            std::set<int> dcSet(dontCares.begin(), dontCares.end());

            if (isPOS) {
                maxterms = terms;
                for (int i = 0; i < rows; i++) {
                    if (termsSet.find(i) == termsSet.end() && dcSet.find(i) == dcSet.end()) {
                        minterms.push_back(i);
                    }
                }
            } else {
                minterms = terms;
                for (int i = 0; i < rows; i++) {
                    if (termsSet.find(i) == termsSet.end() && dcSet.find(i) == dcSet.end()) {
                        maxterms.push_back(i);
                    }
                }
            }

            std::vector<std::string> originalPostfix = { "dummy" };
            bool isAlwaysTrue = (minterms.size() + dontCares.size() == static_cast<size_t>(rows));
            bool isAlwaysFalse = minterms.empty();

            QuineMcCluskey::MinimizationResult sopResult = QuineMcCluskey::minimizeWithDetails(numVars, minterms, dontCares);
            std::vector<std::string> simplifiedTerms = sopResult.solution;

            QuineMcCluskey::MinimizationResult posResult = QuineMcCluskey::minimizeWithDetails(numVars, maxterms, dontCares);
            std::vector<std::string> simplifiedTermsPOS = posResult.solution;

            std::string combinedLogs = "=== SOP Minimization ===\n" + sopResult.stepsLog +
                                       "\n\n=== POS Minimization ===\n" + posResult.stepsLog;

            std::string simplifiedExpr = buildSopExpression(simplifiedTerms, vars);
            std::string simplifiedExprPOS = buildPosExpression(simplifiedTermsPOS, vars);

            std::vector<std::string> allSopExprs;
            for (const auto& sol : sopResult.allSolutions) {
                allSopExprs.push_back(buildSopExpression(sol, vars));
            }
            std::sort(allSopExprs.begin(), allSopExprs.end(), compareSopTerms);
            allSopExprs.erase(std::unique(allSopExprs.begin(), allSopExprs.end()), allSopExprs.end());
            if (!allSopExprs.empty()) {
                simplifiedExpr = allSopExprs[0];
            }

            std::vector<std::string> allPosExprs;
            for (const auto& sol : posResult.allSolutions) {
                allPosExprs.push_back(buildPosExpression(sol, vars));
            }
            std::sort(allPosExprs.begin(), allPosExprs.end(), compareSopTerms);
            allPosExprs.erase(std::unique(allPosExprs.begin(), allPosExprs.end()), allPosExprs.end());
            if (!allPosExprs.empty()) {
                simplifiedExprPOS = allPosExprs[0];
            }

            return ProcessResult::builder()
                .variables(vars)
                .originalPostfix(originalPostfix)
                .simplifiedTerms(simplifiedTerms)
                .simplifiedTermsPOS(simplifiedTermsPOS)
                .minterms(minterms)
                .dontCares(dontCares)
                .stepsLog(combinedLogs)
                .alwaysTrue(isAlwaysTrue)
                .alwaysFalse(isAlwaysFalse)
                .simplifiedExpression(simplifiedExpr)
                .simplifiedExpressionPOS(simplifiedExprPOS)
                .allSolutions(allSopExprs)
                .allSolutionsPOS(allPosExprs)
                .allRawSolutions(sopResult.allSolutions)
                .allRawSolutionsPOS(posResult.allSolutions)
                .primeImplicants(sopResult.primeImplicants)
                .essentialPrimeImplicants(sopResult.essentialPrimeImplicants)
                .primeImplicantsPOS(posResult.primeImplicants)
                .essentialPrimeImplicantsPOS(posResult.essentialPrimeImplicants)
                .build();
        }
    } catch (...) {
        // Fallthrough on failure
    }
    return ProcessResult::empty();
}

std::vector<int> ExpressionProcessor::parseCommaNumbers(const std::string& str) {
    std::vector<int> list;
    if (trim(str).empty()) return list;
    std::vector<std::string> parts = split(str, ',');
    for (const auto& part : parts) {
        std::string s = trim(part);
        if (!s.empty()) {
            try {
                list.push_back(std::stoi(s));
            } catch (...) {}
        }
    }
    return list;
}

bool ExpressionProcessor::isValidSyntax(const std::string& expr) {
    if (trim(expr).empty())
        return true;

    if (tryParseShorthand(expr).isValid()) {
        return true;
    }

    try {
        std::string normalized = normalizeExpression(expr);
        std::vector<std::string> tokens = tokenize(normalized);
        tokens = addImplicitAnd(tokens);

        // Extract variables to enforce maximum limit
        std::vector<std::string> variables;
        std::set<std::string> varSet;
        for (const auto& tok : tokens) {
            if (!tok.empty() && isVarChar(tok[0]) && tok != "0" && tok != "1") {
                if (varSet.find(tok) == varSet.end()) {
                    varSet.insert(tok);
                    variables.push_back(tok);
                }
            }
        }
        if (variables.size() > 6) {
            return false;
        }

        if (!tokens.empty()) {
            std::string last = tokens.back();
            if (last == "&" || last == "|" || last == "^" || last == "@" || last == "=") {
                return false;
            }
        }

        int parens = 0;
        for (const auto& tok : tokens) {
            if (tok == "(")
                parens++;
            if (tok == ")")
                parens--;
            if (parens < 0)
                return false;
        }
        if (parens != 0)
            return false;

        std::vector<std::string> postfix = infixToPostfix(tokens);
        if (postfix.empty() && !tokens.empty())
            return false;

        int depth = 0;
        for (const auto& tok : postfix) {
            if (tok == "0" || tok == "1" || (!tok.empty() && isVarChar(tok[0]))) {
                depth++;
            } else if (tok == "!") {
                if (depth < 1)
                    return false;
            } else if (tok != "(" && tok != ")") {
                // Binary operator
                if (depth < 2)
                    return false;
                depth--;
            }
        }
        return depth == 1;
    } catch (...) {
        return false;
    }
}

std::string ExpressionProcessor::binaryToVariables(const std::string& binary, const std::vector<std::string>& vars, bool isPOS) {
    // Collect literals first, then decide (POS only) whether the clause needs
    // surrounding parens. Parens exist purely to disambiguate an OR-clause of 2+
    // literals from the AND-adjacent clauses beside it - a single literal is never
    // ambiguous and never needs them (final "is this the only clause at all" call
    // is made by buildPosExpression, which strips them again if so).
    std::vector<std::string> literals;
    size_t maxLen = std::min(binary.length(), vars.size());
    for (size_t j = 0; j < maxLen; j++) {
        char bit = binary[j];
        if (bit != '-') {
            std::string lit = vars[j];
            if (isPOS ? (bit == '1') : (bit == '0')) {
                lit += "'";
            }
            literals.push_back(lit);
        }
    }

    if (literals.empty()) {
        return isPOS ? "0" : "1";
    }

    std::stringstream term;
    for (size_t i = 0; i < literals.size(); i++) {
        if (i > 0 && isPOS) term << "+";
        term << literals[i];
    }

    std::string body = term.str();
    if (isPOS) {
        return "(" + body + ")";
    }
    return body;
}

bool ExpressionProcessor::isVarChar(char c) {
    return std::isalnum(static_cast<unsigned char>(c));
}

int ExpressionProcessor::getPrecedence(const std::string& op) {
    if (op == "!") return 5;
    if (op == "&") return 4;
    if (op == "^") return 3;
    if (op == "|") return 3;
    if (op == "@") return 2;
    if (op == "=") return 1;
    return 0;
}

std::vector<std::string> ExpressionProcessor::tokenize(const std::string& expr) {
    std::vector<std::string> tokens;
    std::string operators = "&|+!>()'^=@";

    for (size_t i = 0; i < expr.length(); i++) {
        char c = expr[i];
        if (std::isspace(static_cast<unsigned char>(c)))
            continue;

        if (operators.find(c) != std::string::npos) {
            tokens.push_back(c == '+' ? "|" : std::string(1, c));
        } else if (isVarChar(c)) {
            tokens.push_back(std::string(1, c));
        }
    }
    return tokens;
}

std::vector<std::string> ExpressionProcessor::addImplicitAnd(const std::vector<std::string>& tokens) {
    if (tokens.empty())
        return tokens;

    std::vector<std::string> result;
    result.push_back(tokens[0]);

    for (size_t i = 1; i < tokens.size(); i++) {
        std::string prev = tokens[i - 1];
        std::string curr = tokens[i];

        bool prevIsVar = isVarChar(prev[0]);
        bool currIsVar = isVarChar(curr[0]);
        bool prevIsClose = (prev == ")" || prev == "'");
        bool currIsOpen = (curr == "(" || curr == "!");

        if ((prevIsVar && currIsVar) || (prevIsVar && currIsOpen) ||
            (prevIsClose && currIsVar) || (prevIsClose && currIsOpen)) {
            result.push_back("&");
        }
        result.push_back(curr);
    }
    return result;
}

std::vector<std::string> ExpressionProcessor::infixToPostfix(const std::vector<std::string>& tokens) {
    std::vector<std::string> output;
    std::stack<std::string> opStack;

    for (const auto& tok : tokens) {
        if (!tok.empty() && isVarChar(tok[0])) {
            output.push_back(tok);
        } else if (tok == "(") {
            opStack.push(tok);
        } else if (tok == ")") {
            while (!opStack.empty() && opStack.top() != "(") {
                output.push_back(opStack.top());
                opStack.pop();
            }
            if (!opStack.empty())
                opStack.pop();
        } else if (tok == "'") {
            output.push_back("!");
        } else {
            while (!opStack.empty() && opStack.top() != "(" &&
                   getPrecedence(opStack.top()) >= getPrecedence(tok)) {
                output.push_back(opStack.top());
                opStack.pop();
            }
            opStack.push(tok);
        }
    }

    while (!opStack.empty()) {
        output.push_back(opStack.top());
        opStack.pop();
    }
    return output;
}

bool ExpressionProcessor::evaluatePostfix(const std::vector<std::string>& postfix, const std::map<std::string, bool>& values) {
    std::stack<bool> stack;

    for (const auto& tok : postfix) {
        if (tok == "0") {
            stack.push(false);
        } else if (tok == "1") {
            stack.push(true);
        } else if (!tok.empty() && isVarChar(tok[0])) {
            auto it = values.find(tok);
            stack.push(it != values.end() ? it->second : false);
        } else if (tok == "!") {
            if (stack.empty())
                return false;
            bool topVal = stack.top();
            stack.pop();
            stack.push(!topVal);
        } else if (tok == "&") {
            if (stack.size() < 2)
                return false;
            bool b = stack.top(); stack.pop();
            bool a = stack.top(); stack.pop();
            stack.push(a && b);
        } else if (tok == "|") {
            if (stack.size() < 2)
                return false;
            bool b = stack.top(); stack.pop();
            bool a = stack.top(); stack.pop();
            stack.push(a || b);
        } else if (tok == "^") {
            if (stack.size() < 2)
                return false;
            bool b = stack.top(); stack.pop();
            bool a = stack.top(); stack.pop();
            stack.push(a ^ b);
        } else if (tok == "@") {
            if (stack.size() < 2)
                return false;
            bool b = stack.top(); stack.pop();
            bool a = stack.top(); stack.pop();
            stack.push(!a || b);
        } else if (tok == "=") {
            if (stack.size() < 2)
                return false;
            bool b = stack.top(); stack.pop();
            bool a = stack.top(); stack.pop();
            stack.push(a == b);
        }
    }
    if (stack.empty()) return false;
    return stack.top();
}

std::string ExpressionProcessor::buildSopExpression(const std::vector<std::string>& terms, const std::vector<std::string>& vars) {
    if (terms.empty())
        return "0";
    if (terms.size() == 1 && std::all_of(terms[0].begin(), terms[0].end(), [](char c) { return c == '-'; })) {
        return "1";
    }

    std::vector<std::string> formattedTerms;
    for (const auto& term : terms) {
        std::string raw = binaryToVariables(term, vars, false);
        formattedTerms.push_back(sortLiteralsInTerm(raw));
    }

    std::sort(formattedTerms.begin(), formattedTerms.end(), compareSopTerms);
    formattedTerms.erase(std::unique(formattedTerms.begin(), formattedTerms.end()), formattedTerms.end());

    std::stringstream sb;
    for (size_t i = 0; i < formattedTerms.size(); i++) {
        sb << formattedTerms[i];
        if (i < formattedTerms.size() - 1)
            sb << " + ";
    }
    return sb.str();
}

std::string ExpressionProcessor::buildPosExpression(const std::vector<std::string>& terms, const std::vector<std::string>& vars) {
    if (terms.empty())
        return "1";

    std::vector<std::string> clauses;
    for (const auto& term : terms) {
        clauses.push_back(binaryToVariables(term, vars, true));
    }

    std::sort(clauses.begin(), clauses.end(), compareSopTerms);
    clauses.erase(std::unique(clauses.begin(), clauses.end()), clauses.end());

    std::stringstream sb;
    for (const auto& clause : clauses) {
        sb << clause;
    }
    std::string result = sb.str();

    // A lone clause has no AND-adjacent sibling to be disambiguated from, so its
    // wrapping parens (added by binaryToVariables whenever a clause has 2+ literals)
    // are unnecessary here even though they'd be needed with a second clause present.
    if (clauses.size() == 1 && result.size() >= 2 && result.front() == '(' && result.back() == ')') {
        result = result.substr(1, result.size() - 2);
    }
    return result;
}

std::string ExpressionProcessor::normalizeExpression(const std::string& expr) {
    std::string res = expr;
    res = replaceString(res, "∨", "|");
    res = replaceString(res, "∧", "&");
    res = replaceString(res, "¬", "!");
    res = replaceString(res, "<->", "=");
    res = replaceString(res, "↔", "=");
    res = replaceString(res, "->", "@");
    res = replaceString(res, "→", "@");
    res = replaceString(res, "⊕", "^");

    res = replaceString(res, " XOR ", "^");
    res = replaceString(res, " AND ", "&");
    res = replaceString(res, " NAND ", "~&");
    res = replaceString(res, " NOR ", "~|");
    res = replaceString(res, " XNOR ", "=");
    res = replaceString(res, " OR ", "|");
    res = replaceString(res, " NOT ", "!");
    return res;
}

} // namespace com::mantiq::logic
