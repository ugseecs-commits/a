#include "ASTProver.h"
#include <stack>
#include <sstream>
#include <algorithm>
#include <optional>
#include <unordered_set>
#include <queue>
#include <functional>
#include <cctype>

namespace com::mantiq::logic {

// ---- Safety / performance ceilings ----------------------------------------
// Same philosophy as before: comfortably and quickly handle expressions up to
// ASTProver::kMaxSupportedVariables (6), and degrade gracefully (never lock
// up the browser tab) for anything pathological, in or beyond that range.
//
//  - kMaxSafePassSteps bounds Phase 1 (applySafePass). Every rule in that
//    pass is strictly simplifying or a bounded, non-duplicating
//    normalization (see ASTProver.h), so a legitimate proof finishes in a
//    small fraction of this budget - it's a defensive valve, not a target
//    step count.
//  - Phase 3's search (searchToTarget) is bounded by ProofSearchConfig
//    instead of a fixed constant now: config.maxAddedConsensusTerms caps how
//    many Consensus branches get explored (the reachable state space is
//    bounded by construction - at most 3^n distinct implicants exist for
//    n <= 6 - so this is headroom, not a real limit), and
//    config.deadline/config.cancelFlag give it the same "return the best
//    move found so far" anytime behavior a time-boxed chess engine has, so
//    a pathological or adversarial input degrades gracefully instead of
//    ever locking up the caller.
//  - kMaxTruthTableVars bounds the brute-force 2^n equivalence check used
//    as the last-resort verifier (and as the sole mechanism for inputs
//    beyond kMaxSupportedVariables). Kept well above 6 for headroom.
static const int kMaxSafePassSteps = 300;
static const size_t kMaxTruthTableVars = 12;

using ImpVec = std::vector<Implicant>;

// =============================================================================
// Free-function helpers (no ASTProver instance needed)
// =============================================================================

static std::vector<std::shared_ptr<ASTNode>> getLiterals(const std::shared_ptr<ASTNode>& term, ASTNodeType parentType) {
    std::vector<std::shared_ptr<ASTNode>> lits;
    ASTNodeType childGroupType = (parentType == ASTNodeType::OP_OR) ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;
    if (term->type == childGroupType) {
        lits = term->children;
    } else {
        lits.push_back(term);
    }
    return lits;
}

static bool isComplement(const std::shared_ptr<ASTNode>& a, const std::shared_ptr<ASTNode>& b) {
    if (a->type == ASTNodeType::OP_NOT) {
        return a->children[0]->isEquivalent(b);
    }
    if (b->type == ASTNodeType::OP_NOT) {
        return b->children[0]->isEquivalent(a);
    }
    return false;
}

static void collectVars(const std::shared_ptr<ASTNode>& node, std::set<std::string>& vars) {
    if (!node) return;
    if (node->type == ASTNodeType::VAR) { vars.insert(node->value); return; }
    for (auto& c : node->children) collectVars(c, vars);
}

// Whitespace-trimmed, case-insensitive equality - used to recognize "TRUE"/
// "FALSE" (in any casing, with any surrounding whitespace a caller might
// have typed) as the same thing as a bare "1"/"0" constant target. Kept
// tiny and local rather than pulling in a locale-aware transform, since the
// only alphabet this ever needs to fold is plain ASCII A-Z/a-z.
static std::string trimmed(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}
static bool iequals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); i++) {
        if (std::tolower((unsigned char)a[i]) != std::tolower((unsigned char)b[i])) return false;
    }
    return true;
}

static bool evalAST(const std::shared_ptr<ASTNode>& node, const std::map<std::string, bool>& assign) {
    switch (node->type) {
        case ASTNodeType::CONST_VAL: return node->value == "1";
        case ASTNodeType::VAR: {
            auto it = assign.find(node->value);
            return it != assign.end() && it->second;
        }
        case ASTNodeType::OP_NOT: return !evalAST(node->children[0], assign);
        case ASTNodeType::OP_AND: {
            for (auto& c : node->children) if (!evalAST(c, assign)) return false;
            return true;
        }
        case ASTNodeType::OP_OR: {
            for (auto& c : node->children) if (evalAST(c, assign)) return true;
            return false;
        }
        case ASTNodeType::OP_XOR:
            return evalAST(node->children[0], assign) != evalAST(node->children[1], assign);
        case ASTNodeType::OP_XNOR:
            return evalAST(node->children[0], assign) == evalAST(node->children[1], assign);
        case ASTNodeType::OP_IMPLIES:
            return !evalAST(node->children[0], assign) || evalAST(node->children[1], assign);
    }
    return false;
}

// Full truth-table comparison - a defensive safety net for the rare case where
// the search lands on a differently-shaped but logically identical cover (a
// QM tie) rather than the exact target string, and the sole mechanism used
// for inputs beyond kMaxSupportedVariables.
static bool truthTableEquivalent(const std::shared_ptr<ASTNode>& a, const std::shared_ptr<ASTNode>& b) {
    std::set<std::string> varSet;
    collectVars(a, varSet);
    collectVars(b, varSet);
    std::vector<std::string> vars(varSet.begin(), varSet.end());
    size_t n = vars.size();
    if (n > kMaxTruthTableVars) return false; // pathological input guard
    size_t total = size_t(1) << n;
    for (size_t mask = 0; mask < total; mask++) {
        std::map<std::string, bool> assign;
        for (size_t i = 0; i < n; i++) assign[vars[i]] = (mask >> i) & 1;
        if (evalAST(a, assign) != evalAST(b, assign)) return false;
    }
    return true;
}

// ---- Implicant bit math -----------------------------------------------------
// n <= kMaxSupportedVariables (6) throughout this file, so bits/mask always
// fit comfortably in the low 6 bits of a uint16_t - packed together they fit
// in 12 bits, which is what pack()/kPackDomain below rely on.

static int popcount16(uint16_t x) {
    int c = 0;
    while (x) { c += (x & 1); x >>= 1; }
    return c;
}

static void sortUnique(ImpVec& v) {
    std::sort(v.begin(), v.end());
    v.erase(std::unique(v.begin(), v.end()), v.end());
}

// True if A is strictly more general than B (fewer fixed literals) and
// already covers everything B covers - i.e. B is redundant once A is present.
static bool absorbs(const Implicant& A, const Implicant& B) {
    if (A.mask == B.mask) return false; // same shape - not an absorption relationship
    if ((A.mask & B.mask) != A.mask) return false; // A's fixed bits must be a subset of B's
    return (B.bits & A.mask) == A.bits;
}

// The consensus theorem, expressed directly in bit math: valid iff A and B
// fix exactly one shared variable to opposite values and agree on every
// other shared variable (guaranteed automatically if exactly one shared bit
// differs). When A.mask == B.mask this degenerates to the classic adjacency
// merge (Combining); when the masks differ it's the general consensus term
// (used either to unlock an Absorption/Redundancy elsewhere, or - if it
// already matches an existing term - as evidence that term is redundant).
static std::optional<Implicant> tryConsensus(const Implicant& A, const Implicant& B) {
    uint16_t sharedMask = A.mask & B.mask;
    uint16_t diff = (A.bits ^ B.bits) & sharedMask;
    if (popcount16(diff) != 1) return std::nullopt;
    Implicant C;
    C.mask = (A.mask | B.mask) & (uint16_t)~diff;
    C.bits = (A.bits | B.bits) & C.mask;
    return C;
}

static const int kPackDomain = 1 << 12; // mask,bits each < 64 for n <= 6 -> 12 bits total
static inline uint16_t pack(const Implicant& x) { return (uint16_t)((x.mask << 6) | x.bits); }

// ---- Bulk (branch-free) reduction passes -----------------------------------
// Each pass applies exactly ONE instance of one move (one absorption, one
// adjacency-merge, or one redundancy removal) and stops, so bulkReduce's
// outer loop narrates one step per individual move - "Absorption" then
// "Absorption" then "Combining", etc. - instead of collapsing a whole chain
// into a single opaque "Absorption (6 terms)" jump. (The removedCount/
// pairCount out-params are kept at 0/1 rather than removed outright, since
// bulkReduce's step-labeling ternary already handles both cases correctly.)
// True duplicate terms (idempotence, A+A=A) are NOT narrated at all here -
// they're deduplicated silently by sortUnique() wherever it's called, since
// a bare duplicate carries no proof-worthy content of its own.

// Applies exactly ONE absorption (removes the single term found to be
// covered by some other term already present) and stops - rather than
// batching every absorbable term in the state into one step. This keeps
// the returned proof narratable one move at a time (see bulkReduce): each
// call here is one line in the proof, so a chain of N absorptions reads as
// N distinct, followable steps instead of one "Absorption (N terms)" jump.
static bool bulkAbsorb(ImpVec& state, int& removedCount) {
    size_t n = state.size();
    for (size_t i = 0; i < n; i++) {
        for (size_t j = 0; j < n; j++) {
            if (i == j) continue;
            if (absorbs(state[i], state[j])) {
                state.erase(state.begin() + j);
                removedCount = 1;
                return true;
            }
        }
    }
    removedCount = 0;
    return false;
}

// Applies exactly ONE adjacency-merge (Combining) and stops, for the same
// one-move-per-step reason as bulkAbsorb above.
static bool bulkCombine(ImpVec& state, int& pairCount) {
    size_t n = state.size();
    for (size_t i = 0; i < n; i++) {
        for (size_t j = i + 1; j < n; j++) {
            if (state[i].mask != state[j].mask) continue;
            auto c = tryConsensus(state[i], state[j]);
            if (!c) continue;
            state.erase(state.begin() + j); // erase j first - it's the larger index
            state.erase(state.begin() + i);
            state.push_back(*c);
            sortUnique(state);
            pairCount = 1;
            return true;
        }
    }
    pairCount = 0;
    return false;
}

// Classic consensus-law redundancy: if some term C in the state is exactly
// the consensus of two OTHER terms A, B currently present (e.g. C = yz where
// A = xy, B = x'z), then A and B alone already cover everything C covers -
// C can be dropped. (This is the "AB+AC+BC = AB+AC" case.)
// Drops exactly ONE redundant term (a term that equals the consensus of two
// other terms already present) and stops, for the same one-move-per-step
// reason as bulkAbsorb/bulkCombine above.
// `protect`, when non-null, names one specific (sourceA, sourceB) -> term
// triple that must NOT be used to justify a removal. This exists for exactly
// one reason: consensus(A,B) is always trivially equal to a term C we might
// have *just* added as C = consensus(A,B) - so without this guard, the very
// next bulkRedundancy pass after any Consensus-Add would immediately find
// "A, B together already justify dropping C" and erase the term the search
// just spent a step adding, using no information beyond the fact that C was
// built from A and B in the first place. That's not a real reduction, it's
// self-cancellation - it made the state == what it was before the add (so
// the search's own visited-set then just discards it as already-seen),
// silently converting every Consensus-Add into a guaranteed no-op and
// making any proof that genuinely needs one impossible to find. The guard
// only blocks THIS one specific triple; C is still perfectly eligible to be
// removed via any OTHER pair that also happens to produce it.
static bool bulkRedundancy(ImpVec& state, int& removedCount,
                            const Implicant* protectA = nullptr,
                            const Implicant* protectB = nullptr,
                            const Implicant* protectC = nullptr) {
    size_t n = state.size();
    std::vector<int> indexOfPacked(kPackDomain, -1);
    for (size_t k = 0; k < n; k++) indexOfPacked[pack(state[k])] = (int)k;

    for (size_t i = 0; i < n; i++) {
        for (size_t j = i + 1; j < n; j++) {
            if (state[i].mask == state[j].mask) continue; // that's Combining's job
            auto c = tryConsensus(state[i], state[j]);
            if (!c) continue;
            if (protectC && *c == *protectC &&
                ((state[i] == *protectA && state[j] == *protectB) ||
                 (state[i] == *protectB && state[j] == *protectA))) {
                continue;
            }
            int k = indexOfPacked[pack(*c)];
            if (k >= 0 && (size_t)k != i && (size_t)k != j) {
                state.erase(state.begin() + k);
                removedCount = 1;
                return true;
            }
        }
    }
    removedCount = 0;
    return false;
}

// =============================================================================
// ASTNode
// =============================================================================

std::shared_ptr<ASTNode> ASTNode::clone() const {
    auto copy = std::make_shared<ASTNode>();
    copy->type = type;
    copy->value = value;
    for (const auto& c : children) {
        copy->children.push_back(c->clone());
    }
    return copy;
}

std::string ASTNode::toString(bool isRoot) const {
    if (type == ASTNodeType::VAR || type == ASTNodeType::CONST_VAL) {
        return value;
    }
    if (type == ASTNodeType::OP_NOT) {
        std::string inner = children[0]->toString(false);
        if (children[0]->type == ASTNodeType::VAR || children[0]->type == ASTNodeType::CONST_VAL || children[0]->type == ASTNodeType::OP_NOT) {
            return inner + "'";
        }
        return "(" + inner + ")'";
    }

    if (type == ASTNodeType::OP_XOR || type == ASTNodeType::OP_XNOR || type == ASTNodeType::OP_IMPLIES) {
        std::string opStr = (type == ASTNodeType::OP_XOR) ? " ^ " : (type == ASTNodeType::OP_XNOR) ? " = " : " -> ";
        std::string res = children[0]->toString(false) + opStr + children[1]->toString(false);
        return isRoot ? res : ("(" + res + ")");
    }

    std::string sep = (type == ASTNodeType::OP_OR) ? " + " : "";
    std::string res = "";
    for (size_t i = 0; i < children.size(); i++) {
        std::string childStr = children[i]->toString(false);
        if (type == ASTNodeType::OP_AND && children[i]->type == ASTNodeType::OP_OR) {
            childStr = "(" + childStr + ")";
        }
        res += childStr;
        if (i < children.size() - 1) res += sep;
    }
    return res;
}

bool ASTNode::isEquivalent(const std::shared_ptr<ASTNode>& other) const {
    if (type != other->type) return false;
    if (type == ASTNodeType::VAR || type == ASTNodeType::CONST_VAL) return value == other->value;
    if (children.size() != other->children.size()) return false;

    if (type == ASTNodeType::OP_NOT) {
        return children[0]->isEquivalent(other->children[0]);
    }

    if (type == ASTNodeType::OP_XOR || type == ASTNodeType::OP_XNOR || type == ASTNodeType::OP_IMPLIES) {
        return children[0]->isEquivalent(other->children[0]) && children[1]->isEquivalent(other->children[1]);
    }

    std::vector<bool> matched(other->children.size(), false);
    for (const auto& c1 : children) {
        bool found = false;
        for (size_t j = 0; j < other->children.size(); j++) {
            if (!matched[j] && c1->isEquivalent(other->children[j])) {
                matched[j] = true;
                found = true;
                break;
            }
        }
        if (!found) return false;
    }
    return true;
}

// =============================================================================
// ASTProver: makers / parsing (unchanged)
// =============================================================================

std::shared_ptr<ASTNode> ASTProver::makeNode(ASTNodeType type) {
    auto n = std::make_shared<ASTNode>();
    n->type = type;
    return n;
}

std::shared_ptr<ASTNode> ASTProver::makeVar(const std::string& name) {
    auto n = makeNode(ASTNodeType::VAR);
    n->value = name;
    return n;
}

std::shared_ptr<ASTNode> ASTProver::makeConst(bool val) {
    auto n = makeNode(ASTNodeType::CONST_VAL);
    n->value = val ? "1" : "0";
    return n;
}

std::shared_ptr<ASTNode> ASTProver::makeNot(std::shared_ptr<ASTNode> child) {
    auto n = makeNode(ASTNodeType::OP_NOT);
    n->children.push_back(child);
    return n;
}

std::shared_ptr<ASTNode> ASTProver::makeAnd(std::shared_ptr<ASTNode> left, std::shared_ptr<ASTNode> right) {
    auto n = makeNode(ASTNodeType::OP_AND);
    if (left->type == ASTNodeType::OP_AND) {
        for (auto c : left->children) n->children.push_back(c);
    } else {
        n->children.push_back(left);
    }
    if (right->type == ASTNodeType::OP_AND) {
        for (auto c : right->children) n->children.push_back(c);
    } else {
        n->children.push_back(right);
    }
    return n;
}

std::shared_ptr<ASTNode> ASTProver::makeOr(std::shared_ptr<ASTNode> left, std::shared_ptr<ASTNode> right) {
    auto n = makeNode(ASTNodeType::OP_OR);
    if (left->type == ASTNodeType::OP_OR) {
        for (auto c : left->children) n->children.push_back(c);
    } else {
        n->children.push_back(left);
    }
    if (right->type == ASTNodeType::OP_OR) {
        for (auto c : right->children) n->children.push_back(c);
    } else {
        n->children.push_back(right);
    }
    return n;
}

// Pushes a NOT all the way down to leaves / native-connective boundaries in
// one call - De Morgan + Involution applied repeatedly with no intermediate
// narration - so a proof shows the net effect of negating a whole subtree
// as ONE step ("De Morgan's") instead of one step per tree level (the old
// behavior, which is what produced long alternating
// "De Morgan's -> Involution -> De Morgan's -> Involution..." chains on
// deeply nested input: each single-level push exposed a double-negation
// that needed its own separate cleanup step before the walk could resume).
std::shared_ptr<ASTNode> ASTProver::pushNotInward(const std::shared_ptr<ASTNode>& child) {
    if (child->type == ASTNodeType::OP_NOT) {
        return child->children[0]; // Involution, absorbed silently
    }
    if (child->type == ASTNodeType::CONST_VAL) {
        return makeConst(child->value == "0"); // Constant Negation, absorbed silently
    }
    if (child->type == ASTNodeType::OP_AND || child->type == ASTNodeType::OP_OR) {
        auto n = makeNode(child->type == ASTNodeType::OP_AND ? ASTNodeType::OP_OR : ASTNodeType::OP_AND);
        n->children.reserve(child->children.size());
        for (auto& c : child->children) n->children.push_back(pushNotInward(c));
        return n;
    }
    // VAR, or a native XOR/XNOR/IMPLIES boundary: don't recurse into a
    // native connective here - that would bypass the dedicated NOT-XOR<->
    // XNOR flip (rule 2d) and the "try XOR-identities before expanding"
    // ordering the rest of the pass relies on. Just wrap it.
    return makeNot(child);
}

std::shared_ptr<ASTNode> ASTProver::parsePostfix(const std::vector<std::string>& postfix) {
    std::stack<std::shared_ptr<ASTNode>> s;
    for (const auto& token : postfix) {
        if (token == "&" || token == "AND" || token == "|" || token == "OR" ||
            token == "^" || token == "XOR" || token == "@" || token == "=" || token == "XNOR") {
            if (s.size() < 2) return nullptr;
            auto right = s.top(); s.pop();
            auto left = s.top(); s.pop();

            if (token == "&" || token == "AND") s.push(makeAnd(left, right));
            else if (token == "|" || token == "OR") s.push(makeOr(left, right));
            else if (token == "^" || token == "XOR") {
                auto n = makeNode(ASTNodeType::OP_XOR);
                n->children.push_back(left);
                n->children.push_back(right);
                s.push(n);
            } else if (token == "=" || token == "XNOR") {
                auto n = makeNode(ASTNodeType::OP_XNOR);
                n->children.push_back(left);
                n->children.push_back(right);
                s.push(n);
            } else if (token == "@") {
                auto n = makeNode(ASTNodeType::OP_IMPLIES);
                n->children.push_back(left);
                n->children.push_back(right);
                s.push(n);
            }
        } else if (token == "!" || token == "NOT" || token == "'") {
            if (s.empty()) return nullptr;
            auto child = s.top(); s.pop();
            s.push(makeNot(child));
        } else if (token == "1" || token == "0") {
            s.push(makeConst(token == "1"));
        } else {
            s.push(makeVar(token));
        }
    }
    return s.empty() ? nullptr : s.top();
}

std::shared_ptr<ASTNode> ASTProver::parseQMString(const std::string& qmStr) {
    // Constant target: "1"/"0" (the QM generator's own convention) and also
    // "TRUE"/"FALSE" in any casing, since that's a perfectly reasonable
    // thing for a caller to type/generate for a function that always
    // evaluates to the same value. Without this, "TRUE" fell through to the
    // general SOP-term parser below, which reads any string with no '(' as
    // a sequence of single-character variables ANDed together - so "TRUE"
    // silently became the 4-variable product T*R*U*E instead of the
    // constant 1, and "FALSE" became F*A*L*S*E. That's not a parse failure
    // you'd notice from an error message - it's a quietly wrong target that
    // would then correctly (and confusingly) report as unreachable/
    // non-equivalent for almost any real input.
    std::string t = trimmed(qmStr);
    if (t == "1" || iequals(t, "true")) return makeConst(true);
    if (t == "0" || iequals(t, "false")) return makeConst(false);

    bool isPOSShape = qmStr.find('(') != std::string::npos;

    auto parseTermSOP = [&](const std::string& t) -> std::shared_ptr<ASTNode> {
        std::vector<std::shared_ptr<ASTNode>> vars;
        for (size_t i = 0; i < t.length(); i++) {
            if (t[i] == '\'') {
                if (!vars.empty()) vars.back() = makeNot(vars.back());
            } else if (t[i] != ' ') {
                vars.push_back(makeVar(std::string(1, t[i])));
            }
        }
        if (vars.empty()) return nullptr;
        auto res = vars[0];
        for (size_t i = 1; i < vars.size(); i++) res = makeAnd(res, vars[i]);
        return res;
    };

    if (!isPOSShape) {
        std::vector<std::string> terms;
        std::string current = "";
        for (char c : qmStr) {
            if (c == '+') { terms.push_back(current); current = ""; }
            else if (c != ' ') current += c;
        }
        if (!current.empty()) terms.push_back(current);

        if (terms.empty()) return nullptr;
        auto root = parseTermSOP(terms[0]);
        for (size_t i = 1; i < terms.size(); i++) root = makeOr(root, parseTermSOP(terms[i]));
        return root;
    } else {
        std::vector<std::string> groups;
        std::string current = "";
        bool inGroup = false;
        for (char c : qmStr) {
            if (c == '(') { 
                if (!inGroup && !current.empty()) {
                    groups.push_back(current);
                }
                inGroup = true; 
                current = ""; 
            }
            else if (c == ')') { 
                inGroup = false; 
                groups.push_back(current); 
                current = "";
            }
            else if (inGroup) { current += c; }
            else if (c != ' ') { current += c; }
        }
        if (!inGroup && !current.empty()) {
            groups.push_back(current);
        }

        auto parseGroupPOS = [&](const std::string& g) -> std::shared_ptr<ASTNode> {
            std::vector<std::string> vars;
            std::string curVar = "";
            for (char c : g) {
                if (c == '+') { vars.push_back(curVar); curVar = ""; }
                else if (c != ' ') curVar += c;
            }
            if (!curVar.empty()) vars.push_back(curVar);

            auto parseV = [&](const std::string& v) -> std::shared_ptr<ASTNode> {
                if (v.empty()) return nullptr;
                if (v.back() == '\'') return makeNot(makeVar(v.substr(0, v.length() - 1)));
                return makeVar(v);
            };

            if (vars.empty()) return nullptr;
            auto res = parseV(vars[0]);
            for (size_t i = 1; i < vars.size(); i++) res = makeOr(res, parseV(vars[i]));
            return res;
        };

        if (groups.empty()) return nullptr;
        auto root = parseGroupPOS(groups[0]);
        for (size_t i = 1; i < groups.size(); i++) root = makeAnd(root, parseGroupPOS(groups[i]));
        return root;
    }
}

// =============================================================================
// Phase 1: safe AST cleanup (ported from the original rule set, minus the
// two rules - Consensus and Distributive Expand/Factor - that needed a
// "does this help?" judgment call and now live in Phase 3 instead).
// =============================================================================

bool ASTProver::applySafeRule(std::shared_ptr<ASTNode>& node, std::string& appliedRule) {
    if (!node) return false;

    // 1. Structural Flattening (Associativity). Flatten fully in one call
    // (loop until no same-type child remains) so nothing is left half-done
    // for a later call to silently redo; only surface it as a logged step
    // if toString() actually changed (AND(AND(A,B),C) and the flat AND(A,B,C)
    // print identically, so a flatten can mutate the tree with no visible
    // change - fall through to the rest of this call on the same node
    // instead of ending the pass on an invisible no-op).
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        std::string beforeFlatten = node->toString();
        bool anyFlatten = false;
        bool flattenedThisPass = true;
        while (flattenedThisPass) {
            flattenedThisPass = false;
            std::vector<std::shared_ptr<ASTNode>> newChildren;
            for (auto& child : node->children) {
                if (child->type == node->type) {
                    for (auto& gc : child->children) newChildren.push_back(gc);
                    flattenedThisPass = true;
                } else {
                    newChildren.push_back(child);
                }
            }
            if (flattenedThisPass) {
                node->children = newChildren;
                anyFlatten = true;
            }
        }
        if (anyFlatten) {
            std::string afterFlatten = node->toString();
            if (beforeFlatten != afterFlatten) {
                appliedRule = "Associativity";
                return true;
            }
        }
    }

    // 2. Involution (Double Negation)
    if (node->type == ASTNodeType::OP_NOT) {
        if (node->children[0]->type == ASTNodeType::OP_NOT) {
            node = node->children[0]->children[0];
            appliedRule = "Involution";
            return true;
        }
    }

    // 2b. Constant Negation (0' = 1, 1' = 0)
    if (node->type == ASTNodeType::OP_NOT && node->children[0]->type == ASTNodeType::CONST_VAL) {
        node = makeConst(node->children[0]->value == "0");
        appliedRule = "Constant Negation";
        return true;
    }

    // 2d. NOT(A^B) = A=B, and its dual NOT(A=B) = A^B
    if (node->type == ASTNodeType::OP_NOT && node->children[0]->type == ASTNodeType::OP_XOR) {
        auto n = makeNode(ASTNodeType::OP_XNOR);
        n->children = node->children[0]->children;
        node = n;
        appliedRule = "NOT-XOR to XNOR";
        return true;
    }
    if (node->type == ASTNodeType::OP_NOT && node->children[0]->type == ASTNodeType::OP_XNOR) {
        auto n = makeNode(ASTNodeType::OP_XOR);
        n->children = node->children[0]->children;
        node = n;
        appliedRule = "NOT-XNOR to XOR";
        return true;
    }

    // 2c. Native XOR / Implication / XNOR identities
    if (node->type == ASTNodeType::OP_XOR || node->type == ASTNodeType::OP_XNOR || node->type == ASTNodeType::OP_IMPLIES) {
        auto& L = node->children[0];
        auto& R = node->children[1];

        if (L->type == ASTNodeType::CONST_VAL && R->type == ASTNodeType::CONST_VAL) {
            bool lv = (L->value == "1"), rv = (R->value == "1");
            bool res = (node->type == ASTNodeType::OP_XOR) ? (lv != rv)
                     : (node->type == ASTNodeType::OP_XNOR) ? (lv == rv)
                     : (!lv || rv);
            node = makeConst(res);
            appliedRule = "Constant Folding";
            return true;
        }

        if (node->type == ASTNodeType::OP_XOR) {
            if (L->isEquivalent(R)) { node = makeConst(false); appliedRule = "Complementarity (XOR)"; return true; }
            if (isComplement(L, R)) { node = makeConst(true); appliedRule = "Complementarity (XOR)"; return true; }
            if (L->type == ASTNodeType::CONST_VAL) {
                if (L->value == "0") { node = R; appliedRule = "Identity (XOR)"; return true; }
                node = makeNot(R); appliedRule = "Negation (XOR)"; return true;
            }
            if (R->type == ASTNodeType::CONST_VAL) {
                if (R->value == "0") { node = L; appliedRule = "Identity (XOR)"; return true; }
                node = makeNot(L); appliedRule = "Negation (XOR)"; return true;
            }
        } else if (node->type == ASTNodeType::OP_XNOR) {
            if (L->isEquivalent(R)) { node = makeConst(true); appliedRule = "Complementarity (XNOR)"; return true; }
            if (isComplement(L, R)) { node = makeConst(false); appliedRule = "Complementarity (XNOR)"; return true; }
            if (L->type == ASTNodeType::CONST_VAL) {
                if (L->value == "1") { node = R; appliedRule = "Identity (XNOR)"; return true; }
                node = makeNot(R); appliedRule = "Negation (XNOR)"; return true;
            }
            if (R->type == ASTNodeType::CONST_VAL) {
                if (R->value == "1") { node = L; appliedRule = "Identity (XNOR)"; return true; }
                node = makeNot(L); appliedRule = "Negation (XNOR)"; return true;
            }
        } else { // OP_IMPLIES
            if (L->isEquivalent(R)) { node = makeConst(true); appliedRule = "Implication (Self)"; return true; }
            if (R->type == ASTNodeType::OP_NOT && R->children[0]->isEquivalent(L)) {
                node = makeNot(L->clone()); appliedRule = "Implication (Complement)"; return true;
            }
            if (L->type == ASTNodeType::OP_NOT && L->children[0]->isEquivalent(R)) {
                node = R; appliedRule = "Implication (Complement)"; return true;
            }
            if (L->type == ASTNodeType::CONST_VAL) {
                if (L->value == "0") { node = makeConst(true); appliedRule = "Implication (False Antecedent)"; return true; }
                node = R; appliedRule = "Implication (True Antecedent)"; return true;
            }
            if (R->type == ASTNodeType::CONST_VAL) {
                if (R->value == "1") { node = makeConst(true); appliedRule = "Implication (True Consequent)"; return true; }
                node = makeNot(L); appliedRule = "Implication (False Consequent)"; return true;
            }
        }
    }

    // 3. Constant Annihilation and Identity
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        // Annihilation (A*0=0, A+1=1) always wins outright the moment any
        // annihilating constant is found anywhere in the children - the
        // whole node collapses in this one step regardless of what else is
        // present, so this stays a simple first-match scan.
        for (auto& c : node->children) {
            if (c->type != ASTNodeType::CONST_VAL) continue;
            if (node->type == ASTNodeType::OP_AND && c->value == "0") {
                node = makeConst(false);
                appliedRule = "Annihilation";
                return true;
            }
            if (node->type == ASTNodeType::OP_OR && c->value == "1") {
                node = makeConst(true);
                appliedRule = "Annihilation";
                return true;
            }
        }

        // Identity (A*1=A, A+0=A): drop EVERY redundant neutral-element
        // constant in this same pass, not just the first one found. Each
        // such constant is independently redundant against the original
        // children list - dropping one never depends on, or changes whether,
        // another should also be dropped - so e.g. A*1*1*1 collapses to A in
        // one narrated "Identity" step instead of three (previously this
        // erased a single constant and returned, so applySafePass's outer
        // loop had to re-invoke this rule once per redundant constant -
        // the same bug class Idempotence had).
        std::vector<std::shared_ptr<ASTNode>> kept;
        kept.reserve(node->children.size());
        bool removedAny = false;
        std::string neutralValue = (node->type == ASTNodeType::OP_AND) ? "1" : "0";
        for (auto& c : node->children) {
            if (c->type == ASTNodeType::CONST_VAL && c->value == neutralValue) {
                removedAny = true;
                continue;
            }
            kept.push_back(c);
        }
        if (removedAny) {
            node->children = kept;
            if (node->children.empty()) {
                // Vacuous case (e.g. the node was made entirely of neutral
                // constants) - AND of nothing is true, OR of nothing is false.
                node = makeConst(node->type == ASTNodeType::OP_AND);
            } else if (node->children.size() == 1) {
                node = node->children[0];
            }
            appliedRule = "Identity";
            return true;
        }
    }

    // 4. Complementarity (A * A' = 0, A + A' = 1)
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        for (size_t i = 0; i < node->children.size(); i++) {
            for (size_t j = i + 1; j < node->children.size(); j++) {
                auto& ci = node->children[i];
                auto& cj = node->children[j];
                bool isComp = false;
                if (ci->type == ASTNodeType::OP_NOT && ci->children[0]->isEquivalent(cj)) isComp = true;
                if (cj->type == ASTNodeType::OP_NOT && cj->children[0]->isEquivalent(ci)) isComp = true;

                if (isComp) {
                    // A single complementary pair anywhere in the children
                    // is, on its own, already sufficient to determine the
                    // WHOLE node's value (A*A'*B*C=0 no matter what B and C
                    // are) - so collapse directly to the constant in this
                    // one step regardless of how many siblings are present,
                    // rather than only doing that for the 2-child case and
                    // otherwise leaving a raw 0/1 embedded among the other
                    // children (e.g. "0BC") for a separate later
                    // Annihilation step to finish off.
                    node = makeConst(node->type == ASTNodeType::OP_OR);
                    appliedRule = "Complementarity";
                    return true;
                }
            }
        }
    }

    // 5. Idempotence (A + A = A, A * A = A)
    // Collapse EVERY sibling equivalent to children[i] in this same pass,
    // not just the first duplicate found - otherwise a run like
    // A*A*A*A*A*A*A gets narrated as six separate "Idempotence" steps (one
    // duplicate erased per call, since applySafeRule returns after a single
    // change and applySafePass just calls it again), when it's really one
    // rule application: "drop the repeats of A". Walk j backward from the
    // end so erasing doesn't disturb the indices still to be checked.
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        for (size_t i = 0; i < node->children.size(); i++) {
            bool removedAny = false;
            for (size_t j = node->children.size(); j-- > i + 1; ) {
                if (node->children[i]->isEquivalent(node->children[j])) {
                    node->children.erase(node->children.begin() + j);
                    removedAny = true;
                }
            }
            if (removedAny) {
                if (node->children.size() == 1) {
                    node = node->children[0];
                }
                appliedRule = "Idempotence";
                return true;
            }
        }
    }

    // 5b. XOR/XNOR Complementarity: X^Y and X=Y over the same operand pair
    // are always exact complements - AND-ing them is always 0, OR-ing them
    // is always 1.
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        for (size_t i = 0; i < node->children.size(); i++) {
            for (size_t j = i + 1; j < node->children.size(); j++) {
                auto& ci = node->children[i];
                auto& cj = node->children[j];
                bool isXorXnorPair = (ci->type == ASTNodeType::OP_XOR && cj->type == ASTNodeType::OP_XNOR)
                                  || (ci->type == ASTNodeType::OP_XNOR && cj->type == ASTNodeType::OP_XOR);
                if (!isXorXnorPair) continue;
                bool sameOperands = (ci->children[0]->isEquivalent(cj->children[0]) && ci->children[1]->isEquivalent(cj->children[1]))
                                  || (ci->children[0]->isEquivalent(cj->children[1]) && ci->children[1]->isEquivalent(cj->children[0]));
                if (!sameOperands) continue;

                // Same reasoning as plain Complementarity above: one such
                // pair anywhere fully determines the whole node, so collapse
                // directly instead of embedding a raw constant among the
                // other children for a later Annihilation step to clean up.
                node = makeConst(node->type == ASTNodeType::OP_OR);
                appliedRule = "Complementarity (XOR/XNOR)";
                return true;
            }
        }
    }

    // 5c. XOR/XNOR Absorption: a literal sibling that matches (or complements)
    // one operand of a neighbouring XOR/XNOR term collapses that whole term
    // down to a plain literal, without needing to fully expand it first.
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        for (size_t i = 0; i < node->children.size(); i++) {
            for (size_t j = 0; j < node->children.size(); j++) {
                if (i == j) continue;
                auto& ci = node->children[i];
                auto& cj = node->children[j];
                if (cj->type != ASTNodeType::OP_XOR && cj->type != ASTNodeType::OP_XNOR) continue;

                auto& P = cj->children[0];
                auto& Q = cj->children[1];
                bool matchP = ci->isEquivalent(P);
                bool compP  = !matchP && isComplement(ci, P);
                bool matchQ = !matchP && !compP && ci->isEquivalent(Q);
                bool compQ  = !matchP && !compP && !matchQ && isComplement(ci, Q);
                if (!matchP && !compP && !matchQ && !compQ) continue;

                auto& other = (matchP || compP) ? Q : P;
                bool negatedMatch = compP || compQ;
                bool isXnor = (cj->type == ASTNodeType::OP_XNOR);
                bool isAndNode = (node->type == ASTNodeType::OP_AND);
                bool needsNot = isAndNode ? (negatedMatch == isXnor) : (negatedMatch != isXnor);

                node->children[j] = needsNot ? makeNot(other->clone()) : other->clone();
                appliedRule = isXnor ? "XNOR Absorption" : "XOR Absorption";
                return true;
            }
        }
    }

    // 6. Recurse into children
    for (auto& child : node->children) {
        if (applySafeRule(child, appliedRule)) return true;
    }

    // 6b. Last resort for this node: nothing above resolved it and nothing
    // inside its subtree changed either, so a native XOR/Implication/XNOR
    // here genuinely can't be simplified further while staying in its own
    // connective. Only now expand it to AND/OR/NOT, as its own logged step,
    // so the rest of the toolkit (Absorption, Redundancy, Combining, and
    // Phase 3's search) can work on it.
    if (node->type == ASTNodeType::OP_XOR) {
        auto& L = node->children[0];
        auto& R = node->children[1];
        node = makeOr(makeAnd(L->clone(), makeNot(R->clone())), makeAnd(makeNot(L->clone()), R->clone()));
        appliedRule = "Normalize (Expand XOR)";
        return true;
    }
    if (node->type == ASTNodeType::OP_XNOR) {
        auto& L = node->children[0];
        auto& R = node->children[1];
        node = makeOr(makeAnd(L->clone(), R->clone()), makeAnd(makeNot(L->clone()), makeNot(R->clone())));
        appliedRule = "Normalize (Expand XNOR)";
        return true;
    }
    if (node->type == ASTNodeType::OP_IMPLIES) {
        auto& L = node->children[0];
        auto& R = node->children[1];
        node = makeOr(makeNot(L->clone()), R->clone());
        appliedRule = "Normalize (Expand Implication)";
        return true;
    }

    // 7. Post-recursion simplify (single child elimination)
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        if (node->children.size() == 1) {
            node = node->children[0];
            appliedRule = "Simplify";
            return true;
        }
    }

    // 8. Absorption (generalized to full literal-set subsumption): if term
    // J's literal set is a strict superset of term I's (same grouping), J
    // is redundant.
    if (node->type == ASTNodeType::OP_AND || node->type == ASTNodeType::OP_OR) {
        for (size_t i = 0; i < node->children.size(); i++) {
            auto litsI = getLiterals(node->children[i], node->type);
            for (size_t j = 0; j < node->children.size(); j++) {
                if (i == j) continue;
                auto litsJ = getLiterals(node->children[j], node->type);
                if (litsJ.size() <= litsI.size()) continue;

                bool isSubset = true;
                for (auto& li : litsI) {
                    bool found = false;
                    for (auto& lj : litsJ) {
                        if (li->isEquivalent(lj)) { found = true; break; }
                    }
                    if (!found) { isSubset = false; break; }
                }
                if (isSubset) {
                    node->children.erase(node->children.begin() + j);
                    appliedRule = "Absorption";
                    return true;
                }
            }
        }

        // Redundancy / Elimination: A + A'B = A + B (OR node), dual for AND.
        // Applies ONE elimination and returns - not a "while(foundOne)" bulk
        // pass - so a chain like A + A'B + A'B'C + A'B'C'D unrolls into one
        // narrated "Redundancy" step per literal dropped (applySafePass's
        // own outer loop re-invokes this rule for the next one) instead of
        // collapsing the whole chain into a single "Redundancy (N terms)"
        // jump that's hard to follow.
        {
            ASTNodeType groupType = (node->type == ASTNodeType::OP_OR) ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;
            for (size_t i = 0; i < node->children.size(); i++) {
                for (size_t j = 0; j < node->children.size(); j++) {
                    if (i == j) continue;
                    auto& ci = node->children[i];
                    auto& cj = node->children[j];

                    if (cj->type == groupType) {
                        for (size_t k = 0; k < cj->children.size(); k++) {
                            auto& gc = cj->children[k];
                            bool isInv = false;
                            if (gc->type == ASTNodeType::OP_NOT && gc->children[0]->isEquivalent(ci)) isInv = true;
                            if (ci->type == ASTNodeType::OP_NOT && ci->children[0]->isEquivalent(gc)) isInv = true;

                            if (isInv) {
                                std::vector<std::shared_ptr<ASTNode>> distributedTerms;
                                for (auto& childOfCj : cj->children) {
                                    std::shared_ptr<ASTNode> term;
                                    if (node->type == ASTNodeType::OP_AND) {
                                        term = makeAnd(ci->clone(), childOfCj->clone());
                                    } else {
                                        term = makeOr(ci->clone(), childOfCj->clone());
                                    }
                                    distributedTerms.push_back(term);
                                }

                                std::shared_ptr<ASTNode> distributedGroup;
                                if (node->type == ASTNodeType::OP_AND) {
                                    distributedGroup = makeNode(ASTNodeType::OP_OR);
                                    distributedGroup->children = distributedTerms;
                                } else {
                                    distributedGroup = makeNode(ASTNodeType::OP_AND);
                                    distributedGroup->children = distributedTerms;
                                }

                                if (node->children.size() == 2) {
                                    node = distributedGroup;
                                } else {
                                    size_t firstErase = std::max(i, j);
                                    size_t secondErase = std::min(i, j);
                                    node->children.erase(node->children.begin() + firstErase);
                                    node->children.erase(node->children.begin() + secondErase);
                                    node->children.push_back(distributedGroup);
                                }
                                appliedRule = "Distributive Law";
                                return true;
                            }
                        }
                    }
                }
            }
        }

        // Adjacency: AB + A'B = B (OR node), dual for AND. Applies ONE merge
        // and returns - not a "while(foundOne)" bulk pass - for the same
        // one-step-per-move reason as Redundancy/Elimination just above.
        {
            ASTNodeType groupType = (node->type == ASTNodeType::OP_OR) ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;
            for (size_t i = 0; i < node->children.size(); i++) {
                for (size_t j = i + 1; j < node->children.size(); j++) {
                    auto& ci = node->children[i];
                    auto& cj = node->children[j];

                    std::vector<std::shared_ptr<ASTNode>> termsI;
                    std::vector<std::shared_ptr<ASTNode>> termsJ;
                    if (ci->type == groupType) termsI = ci->children; else termsI.push_back(ci);
                    if (cj->type == groupType) termsJ = cj->children; else termsJ.push_back(cj);

                    if (termsI.size() == termsJ.size()) {
                        std::vector<std::shared_ptr<ASTNode>> common;
                        std::shared_ptr<ASTNode> diffI = nullptr;
                        std::shared_ptr<ASTNode> diffJ = nullptr;

                        std::vector<bool> usedJ(termsJ.size(), false);
                        for (auto& ti : termsI) {
                            bool found = false;
                            for (size_t k = 0; k < termsJ.size(); k++) {
                                if (!usedJ[k] && ti->isEquivalent(termsJ[k])) {
                                    common.push_back(ti);
                                    usedJ[k] = true;
                                    found = true;
                                    break;
                                }
                            }
                            if (!found) diffI = ti;
                        }

                        for (size_t k = 0; k < termsJ.size(); k++) {
                            if (!usedJ[k]) diffJ = termsJ[k];
                        }

                        if (common.size() == termsI.size() - 1 && diffI && diffJ) {
                            bool isInv = false;
                            if (diffI->type == ASTNodeType::OP_NOT && diffI->children[0]->isEquivalent(diffJ)) isInv = true;
                            if (diffJ->type == ASTNodeType::OP_NOT && diffJ->children[0]->isEquivalent(diffI)) isInv = true;

                            if (isInv) {
                                std::shared_ptr<ASTNode> res;
                                if (common.empty()) {
                                    res = makeConst(node->type == ASTNodeType::OP_OR);
                                } else if (common.size() == 1) {
                                    res = common[0];
                                } else {
                                    res = makeNode(groupType);
                                    res->children = common;
                                }
                                node->children.erase(node->children.begin() + j);
                                node->children[i] = res;
                                appliedRule = "Adjacency";
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }

    // De Morgan's - lives outside the AND/OR block since OP_NOT is mutually
    // exclusive with that guard. E.g. (A+B)' -> A'B', (AB)' -> A'+B'.
    // Pushed all the way to leaves/connective boundaries in one shot via
    // pushNotInward, so a deeply nested NOT collapses to its fully-resolved
    // form as a single narrated step instead of re-entering this whole
    // depth-first scan from the root once per tree level.
    if (node->type == ASTNodeType::OP_NOT &&
        (node->children[0]->type == ASTNodeType::OP_OR || node->children[0]->type == ASTNodeType::OP_AND)) {
        node = pushNotInward(node->children[0]);
        appliedRule = "De Morgan's";
        return true;
    }

    return false;
}

void ASTProver::applySafePass(std::shared_ptr<ASTNode>& node, std::vector<std::pair<std::string, std::string>>& steps) {
    // lastShown tracks the text the reader has actually seen so far - either
    // this call's starting point, or (if `steps` already has entries from
    // earlier in this proof) implicitly the same text as steps.back().second,
    // since `node` always mirrors whatever was last logged.
    //
    // A rule can legitimately return true - the tree really did change - and
    // still produce a toString() identical to before: e.g. Simplify (rule 7)
    // unwrapping a now-single-child AND/OR left behind by an earlier
    // Absorption/Complementarity/etc. is a real structural change (the
    // redundant wrapper node is gone), but a length-1 AND/OR already prints
    // exactly like its lone child, so nothing about what the reader SEES
    // changes. Logging that as its own step shows the same expression twice
    // in a row for no visible reason ("-- (Absorption) --> AB" immediately
    // followed by "-- (Simplify) --> AB"). This check is a blanket net at
    // the driver level rather than a fix inside any one rule, specifically
    // so it catches this regardless of which rule causes it, current or
    // future - if the printed text didn't move, the step doesn't get
    // logged, full stop, and the pass just keeps going on the (structurally,
    // if not visibly) updated tree until something the reader can actually
    // see changes.
    std::string lastShown = node->toString();
    int guard = 0;
    while (guard++ < kMaxSafePassSteps) {
        std::string rule;
        if (!applySafeRule(node, rule)) break;
        std::string now = node->toString();
        if (now == lastShown) continue; // invisible to the reader - don't log it, keep going
        steps.push_back({rule, now});
        lastShown = now;
    }
}

// =============================================================================
// Phase 2: literal-ization
// =============================================================================

enum class LitResult { PURE, DEGENERATE, NEEDS_EXPANSION };

// Tries to read `term` as a flat conjunction/disjunction (matching termType)
// of plain literals (VAR or NOT(VAR)). Fails (NEEDS_EXPANSION) the moment it
// finds anything else nested inside - the caller then falls back to
// evaluating that one term out to its exact minterms instead.
static LitResult extractLiteralTerm(const std::shared_ptr<ASTNode>& term, ASTNodeType termType,
                                     const std::vector<std::string>& vars, Implicant& out) {
    std::vector<std::shared_ptr<ASTNode>> lits;
    if (term->type == termType) lits = term->children;
    else if (term->type == ASTNodeType::VAR || term->type == ASTNodeType::OP_NOT) lits.push_back(term);
    else return LitResult::NEEDS_EXPANSION;

    uint16_t bits = 0, mask = 0;
    for (auto& lit : lits) {
        auto base = lit;
        bool neg = false;
        if (base->type == ASTNodeType::OP_NOT) { neg = true; base = base->children[0]; }
        if (base->type != ASTNodeType::VAR) return LitResult::NEEDS_EXPANSION;

        int idx = -1;
        for (size_t k = 0; k < vars.size(); k++) if (vars[k] == base->value) { idx = (int)k; break; }
        if (idx < 0) return LitResult::NEEDS_EXPANSION;

        uint16_t bit = (uint16_t)(1u << idx);
        if (mask & bit) {
            bool existingPolarity = (bits & bit) != 0;
            if (existingPolarity == neg) return LitResult::DEGENERATE; // e.g. A * A'
            continue; // duplicate literal, same polarity - harmless
        }
        mask |= bit;
        if (!neg) bits |= bit;
    }
    out.bits = bits;
    out.mask = mask;
    return LitResult::PURE;
}

// Standard Boolean distribution, generalized to n-ary factors:
//   sumType(productType(...)) <- distributing productType over sumType
// e.g. factors = children of an AND node, sumType=OR, productType=AND turns
// (P1+P2)(Q1+Q2+Q3) into an OR of the 2*3=6 AND-products P_i*Q_j - the
// textbook step for turning a Product-of-Sums-shaped subtree into
// Sum-of-Products form. Passing sumType=AND, productType=OR does the exact
// dual for POS-shaping. A factor that isn't already sumType-shaped is
// treated as a single-term sum (so plain literals/AND-terms pass through
// untouched when distributing toward SOP, and vice versa).
static std::shared_ptr<ASTNode> distributeNode(std::function<std::shared_ptr<ASTNode>(ASTNodeType)> makeNodeFn,
                                                const std::vector<std::shared_ptr<ASTNode>>& factors,
                                                ASTNodeType sumType, ASTNodeType productType) {
    std::vector<std::vector<std::shared_ptr<ASTNode>>> acc = {{}};
    for (auto& f : factors) {
        std::vector<std::shared_ptr<ASTNode>> terms;
        if (f->type == sumType) terms = f->children; else terms.push_back(f);
        std::vector<std::vector<std::shared_ptr<ASTNode>>> next;
        next.reserve(acc.size() * terms.size());
        for (auto& partial : acc) {
            for (auto& t : terms) {
                auto combo = partial;
                combo.push_back(t);
                next.push_back(std::move(combo));
            }
        }
        acc = std::move(next);
    }
    std::vector<std::shared_ptr<ASTNode>> sumTerms;
    sumTerms.reserve(acc.size());
    for (auto& combo : acc) {
        if (combo.size() == 1) { sumTerms.push_back(combo[0]->clone()); continue; }
        auto grp = makeNodeFn(productType);
        for (auto& c : combo) grp->children.push_back(c->clone());
        sumTerms.push_back(grp);
    }
    if (sumTerms.size() == 1) return sumTerms[0];
    auto top = makeNodeFn(sumType);
    top->children = sumTerms;
    return top;
}

// How many AND-products a distribution at this node would produce - the
// combinatorial size Claude's tabular-QM proposal pays unconditionally via
// 2^n minterm evaluation. We only pay it when it's actually this small;
// otherwise we leave this one spot for now (any other impure spot elsewhere
// in the tree is still found and fixed independently - see
// distributeOneImpureSpot), but narrate that decision instead of taking it
// silently.
static long long distributedSize(const std::vector<std::shared_ptr<ASTNode>>& factors, ASTNodeType sumType) {
    long long total = 1;
    for (auto& f : factors) {
        long long termCount = (f->type == sumType) ? (long long)f->children.size() : 1;
        total *= std::max<long long>(termCount, 1);
        if (total > 4096) return total; // clearly over any reasonable cap already
    }
    return total;
}

// Finds ONE impure spot ANYWHERE in the tree - not just at the root - and
// distributes it in place. A node is "impure" iff its own type is
// productType (the type that must never survive as a *term*: AND for SOP,
// OR for POS) and at least one of its children is sumType (the type that
// must never survive as a bare *literal*: OR for SOP, AND for POS). That
// test is depth- and role-agnostic by design: it doesn't matter whether the
// productType node in question IS the whole top level, or is a two-literal
// product like AB' sitting three levels down where a native XOR got
// expanded - either way it violates the shape literalize() requires, and
// the fix is the identical standard distributive law either way
// (distributeNode already treats a sumType-typed factor's children as "the
// alternatives the law fans out over" regardless of whether that factor
// reads to a human as "a clause" or as "a product term" - the algebra
// doesn't care, only the structural type matters).
//
// Recursion is post-order (children are checked before the node itself), so
// the DEEPEST impurity is always fixed first. That matters for two reasons:
// (1) it's what a human does by hand - clear up an inner tangle before
// touching the outer structure around it - and (2) combined with the
// applySafePass mop-up the caller runs after every single fix (which in
// particular drops the tautologous clauses/terms a freshly-distributed
// XOR/XNOR cluster almost always produces, e.g. (A+A')), it keeps every
// individual Distribute step small and keeps the next impurity this
// function finds already-reduced going in - exactly the discipline that
// keeps this from degenerating into the unbounded whole-tree blow-up the
// old design was trying to avoid by punting to evalAST in the first place.
//
// Returns true (and mutates node in place, exactly one spot) the moment one
// fix is made, so the caller can narrate that single step and re-run
// applySafePass before looking for the next spot - the same one-move-per-
// step discipline bulkReduce uses for Absorption/Combining/Redundancy.
static bool distributeOneImpureSpot(std::shared_ptr<ASTNode>& node, ASTNodeType sumType,
                                     ASTNodeType productType, long long hardCap,
                                     const std::function<std::shared_ptr<ASTNode>(ASTNodeType)>& makeNodeFn) {
    if (!node || node->children.empty()) return false;

    for (auto& child : node->children) {
        if (distributeOneImpureSpot(child, sumType, productType, hardCap, makeNodeFn)) return true;
    }

    if (node->type != productType) return false; // fine as-is: already a pure literal/term, or a sum node
    bool anyNestedSum = false;
    for (auto& f : node->children) if (f->type == sumType) { anyNestedSum = true; break; }
    if (!anyNestedSum) return false; // e.g. a plain literal product - nothing to distribute here

    long long size = distributedSize(node->children, sumType);
    // Oversized: leave THIS spot alone for now rather than force an
    // expansion that isn't honest. The caller's outer loop still finds and
    // fixes every OTHER impure spot in the tree independently - only a spot
    // that is individually too big to expand ever falls through to
    // literalize()'s last-resort per-term fallback, and for any input
    // within kMaxSupportedVariables that should not actually happen: the
    // worst case here is bounded by the same 2^n <= 64 ceiling as the whole
    // problem, since every intermediate cleanup pass keeps term counts near
    // their minimal size before the next distribution is attempted.
    if (size > hardCap) return false;

    node = distributeNode(makeNodeFn, node->children, sumType, productType);
    return true;
}

void ASTProver::shapeForLiteralization(std::shared_ptr<ASTNode>& node, bool towardSOP,
                                        const std::vector<std::string>& vars,
                                        std::vector<std::pair<std::string, std::string>>& steps) {
    ASTNodeType sumType = towardSOP ? ASTNodeType::OP_OR : ASTNodeType::OP_AND;
    ASTNodeType productType = towardSOP ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;
    int n = (int)vars.size();
    long long hardCap = (n <= 12) ? (1LL << n) : (1LL << 12); // 2^n is the absolute worst case; never distribute past it

    std::function<std::shared_ptr<ASTNode>(ASTNodeType)> makeNodeFn = [this](ASTNodeType t) { return makeNode(t); };

    // Repeatedly find and fix ONE impure spot anywhere in the tree (deepest
    // first), narrate it as its own "Distribute" step showing the whole
    // current expression, and mop up with applySafePass before looking for
    // the next one. A proof with several XOR/XNOR-derived clusters buried
    // at different depths now gets one clean, algebraic step per cluster,
    // instead of the ones not sitting at the very top silently vanishing
    // into literalize()'s per-term truth-table fallback. Bounded by
    // kMaxSafePassSteps as a defensive ceiling only - a legitimate proof
    // has at most a handful of impure spots to clear, this is headroom.
    int guard = 0;
    while (guard++ < kMaxSafePassSteps) {
        if (!distributeOneImpureSpot(node, sumType, productType, hardCap, makeNodeFn)) break;
        steps.push_back({towardSOP ? "Distribute (expand into Sum-of-Products form)"
                                    : "Distribute (expand into Product-of-Sums form)",
                          node->toString()});
        // Distributing duplicates literals across the new terms (e.g. AB and
        // AC out of A(B+C)) and very often produces an immediate tautology
        // (e.g. (A+A') out of an XOR-derived cluster) - the usual
        // absorption/idempotence/redundancy/complementarity cleanup almost
        // always has real work to do here, so fold it in right away rather
        // than leaving it for the search to rediscover, and so the next
        // impurity this loop finds is already as small as it can be.
        applySafePass(node, steps);
    }
}

bool ASTProver::literalize(const std::shared_ptr<ASTNode>& node, bool towardSOP,
                            const std::vector<std::string>& vars, std::vector<Implicant>& out,
                            std::vector<std::pair<std::string, std::string>>* steps) {
    if (!node) return false;

    if (node->type == ASTNodeType::CONST_VAL) {
        if ((towardSOP && node->value == "1") || (!towardSOP && node->value == "0")) {
            out.push_back(Implicant{0, 0}); // maximally general - covers everything
        }
        return true; // else: empty cover (constant false SOP / true POS)
    }

    ASTNodeType topType = towardSOP ? ASTNodeType::OP_OR : ASTNodeType::OP_AND;
    ASTNodeType termType = towardSOP ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;

    std::vector<std::shared_ptr<ASTNode>> terms;
    if (node->type == topType) terms = node->children;
    else terms.push_back(node);

    auto buildLiteralNode = [&](const Implicant& im) -> std::shared_ptr<ASTNode> {
        std::vector<std::shared_ptr<ASTNode>> lits;
        for (size_t k = 0; k < vars.size(); k++) {
            uint16_t bit = (uint16_t)(1u << k);
            if (im.mask & bit) {
                auto v = makeVar(vars[k]);
                lits.push_back((im.bits & bit) ? v : makeNot(v));
            }
        }
        if (lits.empty()) return makeConst(towardSOP);
        if (lits.size() == 1) return lits[0];
        auto grp = makeNode(termType);
        grp->children = lits;
        return grp;
    };
    auto renderList = [&](std::vector<std::shared_ptr<ASTNode>>& list) -> std::string {
        if (list.empty()) return makeConst(!towardSOP)->toString();
        if (list.size() == 1) return list[0]->toString();
        auto top = makeNode(topType);
        top->children = list;
        return top->toString();
    };

    // processedSoFar holds, at every point in the loop, the *replacement*
    // for every term already visited (unchanged if it was already pure,
    // dropped if degenerate, spliced-in-full if it needed expansion) - so a
    // step narrated mid-loop can show processedSoFar + the still-untouched
    // original tail as one honest, complete expression, instead of ever
    // silently jumping from the original straight to a fully-expanded (and
    // possibly already partially re-merged) result.
    std::vector<std::shared_ptr<ASTNode>> processedSoFar;

    for (size_t idx = 0; idx < terms.size(); idx++) {
        auto& t = terms[idx];
        Implicant im;
        LitResult r = extractLiteralTerm(t, termType, vars, im);
        if (r == LitResult::PURE) {
            out.push_back(im);
            processedSoFar.push_back(t->clone());
        } else if (r == LitResult::DEGENERATE) {
            continue; // vacuous term (e.g. contains both A and A') - contributes nothing, safely dropped
        } else {
            // This is now a last-resort SAFETY NET, not a routine path: with
            // shapeForLiteralization distributing every impure spot in the
            // tree (any depth, not just the root) before literalize() ever
            // runs, a term should only land here if an individual spot was
            // too large to expand honestly within the hardCap bound in
            // shapeForLiteralization - which, for any input within
            // kMaxSupportedVariables, should not actually happen. If it
            // ever does fire, the label below says so explicitly rather
            // than reading like a normal derivation step.
            //
            // Bounded by 2^n <= 64 for n <= kMaxSupportedVariables - and
            // restricted to the variables *this term actually mentions*,
            // not the whole problem's variable set. Evaluating over every
            // global variable (most of which this term doesn't reference at
            // all) produces a wave of spurious, duplicate-laden clauses -
            // e.g. a 2-variable XOR factor sitting inside a 3-variable
            // problem would otherwise get needlessly expanded into 4
            // fully-specified 3-literal clauses instead of the 2 clauses
            // (each don't-caring the third variable) it actually needs.
            //
            // Direction matters here: an SOP term's Implicant records the
            // points where the term is TRUE, with bits = that assignment
            // directly (matches extractLiteralTerm's PURE case above). A
            // POS clause's Implicant instead records the single point where
            // the CLAUSE is FALSE, with bits stored as the *complement* of
            // that point (restricted to this term's own mask) - a bare
            // literal (bits_k=1) is false when var_k=0, so bits_k=1 must
            // mean the false-point had var_k=0, i.e. bits = NOT(false-point).
            std::set<std::string> localVarSet;
            collectVars(t, localVarSet);
            std::vector<std::string> localVars(localVarSet.begin(), localVarSet.end());
            std::vector<uint16_t> localBit;
            for (auto& lv : localVars) {
                for (size_t k = 0; k < vars.size(); k++) {
                    if (vars[k] == lv) { localBit.push_back((uint16_t)(1u << k)); break; }
                }
            }
            int ln = (int)localVars.size();
            uint16_t localMask = 0;
            for (auto b : localBit) localMask |= b;

            std::vector<Implicant> local;
            std::map<std::string, bool> assign;
            for (int m = 0; m < (1 << ln); m++) {
                for (int k = 0; k < ln; k++) assign[localVars[k]] = (m >> k) & 1;
                bool val = evalAST(t, assign);
                uint16_t bits = 0;
                for (int k = 0; k < ln; k++) if ((m >> k) & 1) bits |= localBit[k];
                if (towardSOP) {
                    if (val) local.push_back(Implicant{bits, localMask});
                } else {
                    if (!val) local.push_back(Implicant{(uint16_t)(~bits & localMask), localMask});
                }
            }
            sortUnique(local);
            out.insert(out.end(), local.begin(), local.end());
            for (auto& lim : local) processedSoFar.push_back(buildLiteralNode(lim));

            if (steps) {
                std::vector<std::shared_ptr<ASTNode>> preview = processedSoFar;
                for (size_t k = idx + 1; k < terms.size(); k++) preview.push_back(terms[k]->clone());
                steps->push_back({"Exhaustive Case Analysis for '" + t->toString() +
                                   "' (safety-net: exceeded the safe algebraic-distribution bound)",
                                   renderList(preview)});
            }
        }
    }
    sortUnique(out);
    return true;
}

std::shared_ptr<ASTNode> ASTProver::implicantsToAST(const std::vector<Implicant>& terms, bool towardSOP,
                                                      const std::vector<std::string>& vars) {
    ASTNodeType topType = towardSOP ? ASTNodeType::OP_OR : ASTNodeType::OP_AND;
    ASTNodeType termType = towardSOP ? ASTNodeType::OP_AND : ASTNodeType::OP_OR;

    if (terms.empty()) {
        return makeConst(!towardSOP); // empty SOP cover = 0, empty POS cover = 1
    }

    std::vector<std::shared_ptr<ASTNode>> termNodes;
    for (auto& im : terms) {
        if (im.mask == 0) {
            termNodes.push_back(makeConst(towardSOP)); // fully general term = tautology for this shape
            continue;
        }
        std::vector<std::shared_ptr<ASTNode>> lits;
        for (size_t k = 0; k < vars.size(); k++) {
            uint16_t bit = (uint16_t)(1u << k);
            if (im.mask & bit) {
                auto v = makeVar(vars[k]);
                lits.push_back((im.bits & bit) ? v : makeNot(v));
            }
        }
        if (lits.size() == 1) {
            termNodes.push_back(lits[0]);
        } else {
            auto grp = makeNode(termType);
            grp->children = lits;
            termNodes.push_back(grp);
        }
    }
    if (termNodes.size() == 1) return termNodes[0];
    auto top = makeNode(topType);
    top->children = termNodes;
    return top;
}

// =============================================================================
// Phase 3: bulk reduction + guarded search
// =============================================================================

void ASTProver::bulkReduce(std::vector<Implicant>& state, std::vector<std::pair<std::string, std::string>>& steps,
                            bool towardSOP, const std::vector<std::string>& vars,
                            const Implicant* protectA, const Implicant* protectB, const Implicant* protectC) {
    bool changed = true;
    bool firstPass = true;
    while (changed) {
        changed = false;

        // NOTE: bulkAbsorb/bulkCombine/bulkRedundancy each apply exactly ONE
        // move and return (see their own comments) - removed/pairs/red below
        // are therefore always 0 or 1, never higher. Labels are fixed
        // strings rather than a ">1" ternary for that reason: a batching
        // label that can never actually appear is worse than no ternary at
        // all, since it implies behavior (grouping N moves into one step)
        // that doesn't exist here and could mislead a future change.
        int removed = 0;
        if (bulkAbsorb(state, removed)) {
            steps.push_back({"Absorption", implicantsToAST(state, towardSOP, vars)->toString()});
            changed = true;
            firstPass = false;
            continue;
        }

        int pairs = 0;
        if (bulkCombine(state, pairs)) {
            steps.push_back({"Combining", implicantsToAST(state, towardSOP, vars)->toString()});
            changed = true;
            firstPass = false;
            continue;
        }

        int red = 0;
        // The protection only needs to apply while the freshly-added term
        // (protectC) could still be sitting in the state exactly as added -
        // once anything else has changed the state (or this is a call with
        // no protection at all, e.g. the very first bulkReduce(start) before
        // any search happens), pass no protection and let the rule run in
        // its ordinary, fully general form.
        if (bulkRedundancy(state, red, firstPass ? protectA : nullptr, firstPass ? protectB : nullptr, firstPass ? protectC : nullptr)) {
            steps.push_back({"Redundancy (Consensus)", implicantsToAST(state, towardSOP, vars)->toString()});
            changed = true;
            firstPass = false;
            continue;
        }
    }
}

static int heuristicSymDiff(const ImpVec& s, const ImpVec& goal) {
    size_t i = 0, j = 0;
    int diff = 0;
    while (i < s.size() && j < goal.size()) {
        if (s[i] == goal[j]) { i++; j++; }
        else if (s[i] < goal[j]) { diff++; i++; }
        else { diff++; j++; }
    }
    diff += (int)(s.size() - i) + (int)(goal.size() - j);
    return diff;
}

static std::string stateKey(const ImpVec& s) {
    std::string key;
    key.reserve(s.size() * 2);
    for (auto& im : s) {
        key.push_back((char)(im.mask & 0xFF));
        key.push_back((char)(im.bits & 0xFF));
    }
    return key;
}

// Genuine (unweighted) A*: g = Consensus-additions so far, ordering is
// primarily by g (uniform-cost / breadth-first in additions), with the
// symmetric-diff heuristic used ONLY as a tie-break among equal-g nodes to
// explore more promising states first. Because h never influences whether
// one g-layer is preferred over another, a solution this returns as
// kExactOptimal is provably shortest in added-term count - unlike the old
// kConsensusWeight=2.0 inflation, which explicitly traded that guarantee
// for speed. The state space is bounded (<= 3^n implicants for n <= 6), so
// dropping that shortcut is not a speed problem in practice - it was
// unnecessary insurance against a limit this small already doesn't need.
ProofOutcome ASTProver::searchToTarget(std::vector<Implicant> start, const std::vector<Implicant>& goal,
                                        std::vector<std::pair<std::string, std::string>>& steps,
                                        const std::vector<std::string>& vars, bool towardSOP,
                                        const ProofSearchConfig& config) {
    sortUnique(start);
    bulkReduce(start, steps, towardSOP, vars);
    if (start == goal) return ProofOutcome::kExactOptimal;

    struct QNode {
        ImpVec state;
        std::vector<std::pair<std::string, std::string>> path;
        int g;
        int h;
    };
    struct Cmp {
        // g first (uniform-cost - this is what makes "shortest" provable),
        // h only to break ties between equally-short candidates.
        bool operator()(const QNode& a, const QNode& b) const {
            if (a.g != b.g) return a.g > b.g;
            return a.h > b.h;
        }
    };

    std::priority_queue<QNode, std::vector<QNode>, Cmp> pq;
    std::unordered_set<std::string> visited;

    QNode root{start, {}, 0, heuristicSymDiff(start, goal)};
    pq.push(root);
    visited.insert(stateKey(start));

    // Anytime bookkeeping: the closest-to-goal state seen so far, so that
    // if we're interrupted (deadline or cancelFlag) we hand back honest
    // partial progress instead of nothing - "best move found so far", not
    // "no answer".
    QNode bestSoFar = root;

    long long expansions = 0;
    while (!pq.empty()) {
        if (pq.top().g > config.maxAddedConsensusTerms) break; // defensive ceiling only, see header

        if (++expansions % config.checkEveryNExpansions == 0) {
            bool timeUp = std::chrono::steady_clock::now() >= config.deadline;
            bool cancelled = config.cancelFlag && config.cancelFlag->load(std::memory_order_relaxed);
            if (timeUp || cancelled) {
                steps.insert(steps.end(), bestSoFar.path.begin(), bestSoFar.path.end());
                return ProofOutcome::kTimedOutPartial;
            }
        }

        QNode cur = pq.top();
        pq.pop();
        if (cur.h < bestSoFar.h) bestSoFar = cur;

        // The only branching move left: Consensus. (Absorption/Combining/
        // Redundancy are already exhausted by bulkReduce on every state in
        // this queue - they're applied immediately below whenever a
        // Consensus addition unlocks them.)
        size_t m = cur.state.size();
        for (size_t i = 0; i < m; i++) {
            for (size_t j = i + 1; j < m; j++) {
                if (cur.state[i].mask == cur.state[j].mask) continue; // would already be Combined
                auto c = tryConsensus(cur.state[i], cur.state[j]);
                if (!c) continue;
                if (std::binary_search(cur.state.begin(), cur.state.end(), *c)) continue; // would already be Redundancy

                ImpVec next = cur.state;
                next.push_back(*c);
                sortUnique(next);
                std::string key = stateKey(next);
                if (visited.count(key)) continue;
                visited.insert(key);

                auto childPath = cur.path;
                childPath.push_back({"Consensus (Term Added)", implicantsToAST(next, towardSOP, vars)->toString()});
                bulkReduce(next, childPath, towardSOP, vars, &cur.state[i], &cur.state[j], &(*c));

                if (next == goal) {
                    steps.insert(steps.end(), childPath.begin(), childPath.end());
                    return ProofOutcome::kExactOptimal;
                }

                QNode child{next, std::move(childPath), cur.g + 1, heuristicSymDiff(next, goal)};
                pq.push(std::move(child));
            }
        }
    }

    // Exhausted (or hit the defensive ceiling) without reaching goal -
    // caller falls back to the truth-table bridge, but still gets whatever
    // real partial progress we made.
    steps.insert(steps.end(), bestSoFar.path.begin(), bestSoFar.path.end());
    return ProofOutcome::kBridged;
}

// =============================================================================
// Top level
// =============================================================================

std::string ASTProver::generateProof(const std::vector<std::string>& postfix, const std::string& targetQMExpr) {
    // Default budget: generous enough that ordinary n<=6 input (which
    // finishes in low single-digit milliseconds even under the old,
    // wasteful Phase 1) never comes close to it - see ProofSearchConfig.
    return generateProof(postfix, targetQMExpr, ProofSearchConfig::withBudget(std::chrono::milliseconds(3500)), nullptr);
}

std::string ASTProver::generateProof(const std::vector<std::string>& postfix, const std::string& targetQMExpr,
                                      const ProofSearchConfig& config, ProofOutcome* outcome) {
    if (outcome) *outcome = ProofOutcome::kExactOptimal;

    auto inputAST = parsePostfix(postfix);
    if (!inputAST) return "";

    auto targetAST = parseQMString(targetQMExpr);
    if (!targetAST) return "";

    std::vector<std::pair<std::string, std::string>> forwardSteps;

    // Phase 1: cheap, safe cleanup - resolves every "obviously simple" case
    // (e.g. A + A'B -> A+B) on its own, with zero search overhead.
    applySafePass(inputAST, forwardSteps);

    // Bare-constant target (function is identically 0 or 1). This still runs
    // through the SAME shape/literalize/search machinery as any other
    // target - only the *goal* is fixed directly (the single all-covering
    // term for TRUE, the empty cover for FALSE) instead of coming from
    // literalizing a parsed target string - so a tautology or contradiction
    // that needs real distribution/absorption/consensus to resolve (not
    // just what Phase 1's local tree rules can find) still gets a genuine,
    // narrated step-by-step derivation all the way to the constant, instead
    // of Phase 1 stalling partway and falling straight to a generic
    // "Verified by Truth Table" bridge that discards everything the search
    // could otherwise have proven.
    if (targetAST->type == ASTNodeType::CONST_VAL) {
        // Fast path: Phase 1 alone already collapsed the input to the exact
        // constant asked for (e.g. an Absorption clearing the way for an
        // XNOR self-equivalence right after). Nothing more to do.
        if (inputAST->type == ASTNodeType::CONST_VAL && inputAST->value == targetAST->value) {
            if (!forwardSteps.empty()) forwardSteps.back().second = targetQMExpr;
            return formatProof(forwardSteps, targetQMExpr);
        }
        // Phase 1 alone collapsed the input to the OTHER constant - this is
        // a definitive, already-proven non-equivalence, not merely
        // "couldn't verify" - say so plainly instead of running a
        // (redundant, and misleadingly-hedged) truth-table bridge.
        if (inputAST->type == ASTNodeType::CONST_VAL) {
            if (outcome) *outcome = ProofOutcome::kBridged;
            forwardSteps.push_back({"Proven Not Equivalent (simplifies to " + inputAST->value +
                                     ", not " + targetQMExpr + ")", inputAST->value});
            return formatProof(forwardSteps, targetQMExpr);
        }

        std::set<std::string> constVars;
        collectVars(inputAST, constVars);
        std::vector<std::string> vars(constVars.begin(), constVars.end());
        int n = (int)vars.size();

        if (n > ASTProver::kMaxSupportedVariables) {
            // Same documented oversized-input fallback as the general path
            // below: skip the derivation, just verify and bridge honestly.
            if (outcome) *outcome = ProofOutcome::kBridged;
            if (truthTableEquivalent(inputAST, targetAST)) {
                forwardSteps.push_back({"Equivalent Minimal Form (Verified by Truth Table)", targetQMExpr});
            } else {
                forwardSteps.push_back({"Unverified Bridge (equivalence could not be confirmed)", targetQMExpr});
            }
            return formatProof(forwardSteps, targetQMExpr);
        }

        bool towardSOP = true; // shape is arbitrary for a constant goal - SOP works as well as POS
        shapeForLiteralization(inputAST, towardSOP, vars, forwardSteps);

        std::vector<Implicant> startTerms, goalTerms;
        literalize(inputAST, towardSOP, vars, startTerms, &forwardSteps);
        bool wantTrue = (targetAST->value == "1");
        if (wantTrue) goalTerms.push_back(Implicant{0, 0}); // the single all-covering term = tautology
        // else leave goalTerms empty: the empty cover = contradiction

        ProofOutcome result = searchToTarget(startTerms, goalTerms, forwardSteps, vars, towardSOP, config);

        if (result == ProofOutcome::kExactOptimal) {
            if (!forwardSteps.empty()) forwardSteps.back().second = targetQMExpr;
            return formatProof(forwardSteps, targetQMExpr);
        }

        // Genuinely exhausted or interrupted before finishing - same honest
        // truth-table bridge the general path uses below, just reached only
        // after real derivation work was actually attempted first.
        if (outcome) *outcome = result;
        bool timedOut = (result == ProofOutcome::kTimedOutPartial);
        if (truthTableEquivalent(inputAST, targetAST)) {
            forwardSteps.push_back({timedOut ? "Equivalent Minimal Form (time budget reached - verified by Truth Table)"
                                              : "Equivalent Minimal Form (Verified by Truth Table)",
                                     targetQMExpr});
        } else {
            forwardSteps.push_back({timedOut ? "Time budget reached (equivalence could not be confirmed)"
                                              : "Unverified Bridge (equivalence could not be confirmed)",
                                     targetQMExpr});
        }
        return formatProof(forwardSteps, targetQMExpr);
    }

    // The generator always wraps POS clauses in parentheses and never wraps
    // SOP terms at all - so the target *string* itself tells us its shape
    // directly and unambiguously (more reliable than inspecting the parsed
    // root node type, which is ambiguous for a single-term SOP vs a
    // single-clause POS).
    bool towardSOP = targetQMExpr.find('(') == std::string::npos;

    std::set<std::string> varSet;
    collectVars(inputAST, varSet);
    collectVars(targetAST, varSet);
    std::vector<std::string> vars(varSet.begin(), varSet.end());
    int n = (int)vars.size();

    if (n > ASTProver::kMaxSupportedVariables) {
        // Documented fallback for oversized input: skip the derivation, just
        // verify and bridge honestly.
        if (outcome) *outcome = ProofOutcome::kBridged;
        if (truthTableEquivalent(inputAST, targetAST)) {
            forwardSteps.push_back({"Equivalent Minimal Form (Verified by Truth Table)", targetQMExpr});
        } else {
            forwardSteps.push_back({"Unverified Bridge (equivalence could not be confirmed)", targetQMExpr});
        }
        return formatProof(forwardSteps, targetQMExpr);
    }

    auto targetClean = targetAST->clone();
    std::vector<std::pair<std::string, std::string>> targetCleanupDiscard;
    applySafePass(targetClean, targetCleanupDiscard); // defensive only - target is already minimal SOP/POS

    // Phase 2 shaping: explicit, narrated Distribute step(s) instead of the
    // old silent whole-tree evalAST swallow whenever the top level doesn't
    // already match the shape literalize() needs - see ASTProver.h.
    shapeForLiteralization(inputAST, towardSOP, vars, forwardSteps);

    std::vector<Implicant> startTerms, goalTerms;
    literalize(inputAST, towardSOP, vars, startTerms, &forwardSteps);
    literalize(targetClean, towardSOP, vars, goalTerms);
    sortUnique(goalTerms);

    ProofOutcome result = searchToTarget(startTerms, goalTerms, forwardSteps, vars, towardSOP, config);

    if (result == ProofOutcome::kExactOptimal) {
        if (!forwardSteps.empty()) forwardSteps.back().second = targetQMExpr; // guarantee exact final text
        return formatProof(forwardSteps, targetQMExpr);
    }

    if (outcome) *outcome = result;

    // Either genuinely exhausted (extremely rare for n <= 6, given the
    // bounded state space) or interrupted by the deadline/cancelFlag before
    // finishing. Either way: verify true logical equivalence via truth
    // table before accepting this, and label the bridge honestly - the
    // final line shown to the user is correct in both cases, only the
    // richness of the narration leading up to it differs.
    bool timedOut = (result == ProofOutcome::kTimedOutPartial);
    if (truthTableEquivalent(inputAST, targetAST)) {
        forwardSteps.push_back({timedOut ? "Equivalent Minimal Form (time budget reached - verified by Truth Table)"
                                          : "Equivalent Minimal Form (Verified by Truth Table)",
                                 targetQMExpr});
    } else {
        forwardSteps.push_back({timedOut ? "Time budget reached (equivalence could not be confirmed)"
                                          : "Unverified Bridge (equivalence could not be confirmed)",
                                 targetQMExpr});
    }
    return formatProof(forwardSteps, targetQMExpr);
}

std::string ASTProver::formatProof(const std::vector<std::pair<std::string, std::string>>& forwardSteps,
                                    const std::string& originalTargetStr) {
    if (forwardSteps.empty() && originalTargetStr.empty()) return "";

    if (forwardSteps.empty()) {
        std::stringstream ss;
        ss << "Already in target form:\n" << originalTargetStr << "\n";
        return ss.str();
    }

    std::stringstream ss;
    for (const auto& step : forwardSteps) {
        ss << " -- (" << step.first << ") -->\n" << step.second << "\n";
    }
    return ss.str();
}

} // namespace com::mantiq::logic
