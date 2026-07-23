#pragma once

#include <string>
#include <vector>
#include <memory>
#include <set>
#include <map>
#include <cstdint>
#include <chrono>
#include <atomic>

namespace com::mantiq::logic {

enum class ASTNodeType {
    OP_AND,
    OP_OR,
    OP_NOT,
    OP_XOR,     // kept native (not pre-expanded) so proofs can try XOR-identities first
    OP_IMPLIES, // A -> B, kept native for the same reason
    OP_XNOR,    // A <-> B, kept native for the same reason
    VAR,
    CONST_VAL
};

struct ASTNode {
    ASTNodeType type;
    std::string value; // Variable name if VAR, "1"/"0" if CONST_VAL
    std::vector<std::shared_ptr<ASTNode>> children;

    // Helper functions
    bool isLeaf() const { return children.empty(); }
    std::string toString(bool isRoot = true) const;
    bool isEquivalent(const std::shared_ptr<ASTNode>& other) const;
    std::shared_ptr<ASTNode> clone() const;
};

// One product term (SOP) or sum clause (POS): which variables are fixed
// (mask, bit i set = variable i appears as a literal in this term/clause)
// and what polarity each fixed variable has (bits, bit i = required value).
// This single representation serves both SOP and POS - the *meaning* of
// "fixed" flips (this term requires these values / this clause forbids the
// opposite of these values) but the bit math used to combine, absorb, and
// take the consensus of two implicants is identical either way, so the
// entire search engine below (bulkReduce / searchToTarget) doesn't need to
// know or care whether it's building an SOP or a POS - that only matters at
// the very edges (literalize() going in, implicantsToAST() coming out).
struct Implicant {
    uint16_t bits = 0;
    uint16_t mask = 0;
    bool operator==(const Implicant& o) const { return bits == o.bits && mask == o.mask; }
    bool operator<(const Implicant& o) const { return mask != o.mask ? mask < o.mask : bits < o.bits; }
};

// Anytime-search controls, in the same spirit as a chess engine's time
// control: the caller hands generateProof a deadline and (optionally) a
// cancellation flag it can flip from another thread the moment the request
// is superseded (e.g. the user typed another character). The search checks
// both periodically - never on every node, so the check itself is cheap -
// and if it has to stop early it still returns the best proof found so far
// rather than nothing, exactly like returning "best move so far" when a
// chess engine's clock runs out. For n <= kMaxSupportedVariables the search
// space is bounded (<= 3^n implicant shapes) so in practice this deadline is
// a defensive ceiling, not something normal input is expected to hit - it
// exists so a pathological or adversarial input can never hang the tab, and
// so a superseded in-flight request can be abandoned instantly instead of
// wasting the time slot the next keystroke needs.
struct ProofSearchConfig {
    std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::time_point::max();
    const std::atomic<bool>* cancelFlag = nullptr; // caller sets true to abandon this search
    int checkEveryNExpansions = 256;                // cadence for the clock/cancel check above
    int maxAddedConsensusTerms = 24;                // outer safety ceiling, see searchToTarget

    static ProofSearchConfig withBudget(std::chrono::milliseconds budget) {
        ProofSearchConfig cfg;
        cfg.deadline = std::chrono::steady_clock::now() + budget;
        return cfg;
    }
};

// How a proof attempt concluded, so the caller (and the UI) can tell "we
// proved this is optimal" apart from "we ran out of time/were cancelled and
// this is our best effort so far" apart from "genuinely couldn't do better
// than an honest bridge". The target line shown to the user is ALWAYS
// truth-table-verified correct in every case - only the richness of the
// step-by-step narration on the way there depends on which of these fired.
enum class ProofOutcome {
    kExactOptimal,     // reached the exact target, proven shortest (in added-term count)
    kTimedOutPartial,  // deadline/cancellation hit; returning best partial progress + a verified bridge
    kBridged           // search space genuinely exhausted without matching target exactly; verified bridge
};

class ASTProver {
public:
    // Officially supported ceiling: every other part of the app (K-Map,
    // truth table, etc.) tops out at 6 variables, and the search engine's
    // internal safety valves (in ASTProver.cpp) are sized around this
    // number - normal use never gets close to them. Inputs beyond this are
    // still handled (falling back to a truth-table-verified equivalence
    // bridge) rather than rejected, just without the full step-by-step
    // derivation.
    static constexpr int kMaxSupportedVariables = 6;

    // Backward-compatible entry point: same signature as before, internally
    // runs with a generous default time budget and no external cancel flag.
    std::string generateProof(const std::vector<std::string>& postfix, const std::string& targetQMExpr);

    // Anytime entry point. Give it a deadline (e.g. 3-4s from "Stockfish
    // budget: user will wait, but never show a wrong or absurdly long
    // proof") and, if you're driving this from a worker thread, a
    // cancellation flag your JS glue can flip the instant a newer keystroke
    // supersedes this request - the search notices within
    // checkEveryNExpansions expansions and returns whatever it has, it
    // never has to run to completion to be interrupted. `outcome` tells the
    // caller whether what came back is a proven-optimal derivation or a
    // best-effort one; the returned string's final line is correct either way.
    std::string generateProof(const std::vector<std::string>& postfix, const std::string& targetQMExpr,
                               const ProofSearchConfig& config, ProofOutcome* outcome = nullptr);

private:
    // ---- Parsing (unchanged from the original design) ----
    std::shared_ptr<ASTNode> parsePostfix(const std::vector<std::string>& postfix);
    std::shared_ptr<ASTNode> parseQMString(const std::string& infix);

    // ---- Phase 1: safe, non-explosive AST cleanup ----
    // Every rule here is strictly simplifying (shrinks node count or literal
    // count - flatten, involution, constant folding, complementarity,
    // idempotence, absorption, redundancy, adjacency-merge) or a bounded,
    // non-duplicating normalization (De Morgan, pushed all the way to
    // connective boundaries in one narrated step via pushNotInward - see
    // below - rather than one tree level at a time). Nothing here can grow
    // the tree and nothing here can cycle, so it needs no string-based
    // "seen" guard - just a generous step cap as a pathological-input safety
    // valve.
    //
    // Two things that USED to live here were removed, for opposite reasons:
    //   - Distributive expansion/factoring and the general Consensus
    //     theorem were already moved out (Phase 3) in the previous
    //     iteration, because deciding *when* to restructure/add a term
    //     needs a search, not a local rule.
    //   - Expanding a leftover native XOR/XNOR/IMPLIES to AND/OR/NOT is
    //     still here as the last-resort rule it always was, but it is NOT
    //     "strictly simplifying" the way the rest of this pass is - it
    //     duplicates both operands (1 node becomes 5, 2 of which are full
    //     clones) - and that growth is what used to cascade into long,
    //     mechanical De Morgan/Involution churn once an outer NOT exposed
    //     the freshly-duplicated structure. pushNotInward (below) is the
    //     fix: De Morgan now pushes a NOT all the way to leaves/connective
    //     boundaries in one narrated step instead of one tree level at a
    //     time, so that growth can no longer fan out into dozens of
    //     restart-from-root micro-steps.
    void applySafePass(std::shared_ptr<ASTNode>& node, std::vector<std::pair<std::string, std::string>>& steps);
    bool applySafeRule(std::shared_ptr<ASTNode>& node, std::string& appliedRule);

    // Pushes a NOT all the way to leaves / native-connective boundaries in
    // ONE call - repeated De Morgan + Involution with no intermediate
    // narration - so the proof shows the net result of negating a whole
    // subtree as a single step instead of one step per tree level. Stops
    // (wraps, doesn't recurse) at VAR/CONST leaves and at any native
    // XOR/XNOR/IMPLIES node other than the direct child of the NOT (which
    // still gets its own dedicated flip in applySafeRule, so
    // "try XOR-identities before expanding" is preserved).
    std::shared_ptr<ASTNode> pushNotInward(const std::shared_ptr<ASTNode>& child);

    // ---- Phase 2: shaping + literal-ization (AST -> Implicant set) ----
    // shapeForLiteralization converts whatever applySafePass leaves behind
    // (a pure AND/OR/NOT tree - every native XOR/XNOR/IMPLIES is gone by
    // this point) into the shape literalize() needs: a flat sum of pure
    // literal-terms/clauses. It fixes this at EVERY depth, not just the
    // root - a two-literal product like AB' sitting three levels down,
    // left over from expanding a native XOR, is exactly as "impure" as the
    // whole top level being wrongly shaped, and gets exactly the same
    // treatment. Earlier revisions of this function only checked the root,
    // which meant almost any expression with more than one XOR/XNOR (or
    // any impurity not sitting at the very top) fell straight through
    // literalize()'s per-term fallback and got silently truth-table-dumped
    // instead of algebraically derived - that fallback still exists (see
    // literalize()) but is now a last-resort safety net, not something
    // ordinary input within kMaxSupportedVariables should ever reach.
    //
    // Algorithm: repeatedly (1) scan the whole tree, deepest node first,
    // for one "impure" spot - a node whose own type must never survive as
    // a term (AND for SOP, OR for POS) that has a child of the type that
    // must never survive as a bare literal (OR for SOP, AND for POS); (2)
    // if the combinatorial expansion there is small enough to stay honest
    // (bounded well under the 2^n <= 64 worst case for n <=
    // kMaxSupportedVariables), apply the standard distribution law as ONE
    // narrated "Distribute" step, shown in the context of the whole current
    // expression; (3) re-run the safe pass to mop up whatever that
    // unlocked (very often an immediate tautology, e.g. (A+A'), which is
    // exactly why the mop-up runs before the next impure spot is searched
    // for - it keeps every subsequent Distribute step small). Repeat until
    // no impure spot remains anywhere in the tree.
    void shapeForLiteralization(std::shared_ptr<ASTNode>& node, bool towardSOP,
                                 const std::vector<std::string>& vars,
                                 std::vector<std::pair<std::string, std::string>>& steps);

    // Converts a (shaped) AST into a flat list of Implicants - one per
    // top-level term/clause. A term that's already a pure literal
    // conjunction/disjunction converts directly. Only a term that still
    // contains structure gets evaluated out to its exact minterms via
    // evalAST - bounded by 2^n <= 64. Since shapeForLiteralization now
    // distributes every impure spot in the tree at any depth (not just the
    // root), this is a last-resort safety net for input that exceeds
    // kMaxSupportedVariables' safety margins, not a routine path any
    // ordinary supported proof should hit - and when it does fire, the
    // step it logs says so explicitly rather than presenting itself as a
    // normal algebraic step.
    bool literalize(const std::shared_ptr<ASTNode>& node, bool towardSOP,
                     const std::vector<std::string>& vars, std::vector<Implicant>& out,
                     std::vector<std::pair<std::string, std::string>>* steps = nullptr);

    // ---- Phase 3: goal-directed reduction over Implicant sets ----
    // bulkReduce applies Absorption / Combining / Consensus-based Redundancy
    // to a fixed point in one deterministic, branch-free pass (each strictly
    // shrinks the term count or literal count, so this always terminates and
    // needs no search). Most real inputs finish here - this is the "obvious
    // merges first" behavior a human does by hand.
    //
    // If that stalls short of the target, searchToTarget takes over: a
    // bounded, cancellable, time-boxed best-first search whose *only*
    // branching move is Consensus (add the consensus term of two implicants
    // that share exactly one complementary literal) - the one move that
    // isn't safe to apply unconditionally, because adding a term only helps
    // sometimes. It runs a genuine (not artificially-weighted) A* - g = terms
    // added so far, h = an admissible lower bound on remaining additions -
    // so a result it reports as exact is provably shortest in added-term
    // count, not merely "close". After every tentative addition, bulkReduce
    // immediately folds in whatever that unlocks, so the search tree stays
    // shallow. Bounded by construction for <= kMaxSupportedVariables (at
    // most 3^n distinct implicants exist at all, n <= 6); config.deadline /
    // config.cancelFlag are checked every checkEveryNExpansions pops purely
    // as a defensive ceiling against pathological/adversarial input and as
    // an instant-abandon hook for superseded requests, not as a routine
    // truncation mechanism.
    void bulkReduce(std::vector<Implicant>& state, std::vector<std::pair<std::string, std::string>>& steps,
                     bool towardSOP, const std::vector<std::string>& vars,
                     const Implicant* protectA = nullptr, const Implicant* protectB = nullptr,
                     const Implicant* protectC = nullptr);
    ProofOutcome searchToTarget(std::vector<Implicant> start, const std::vector<Implicant>& goal,
                                 std::vector<std::pair<std::string, std::string>>& steps,
                                 const std::vector<std::string>& vars, bool towardSOP,
                                 const ProofSearchConfig& config);

    // Rebuilds a narratable AST (for toString()/step logging) from an
    // Implicant set - the inverse of literalize() for the pure-literal case.
    std::shared_ptr<ASTNode> implicantsToAST(const std::vector<Implicant>& terms, bool towardSOP,
                                              const std::vector<std::string>& vars);

    std::shared_ptr<ASTNode> makeNode(ASTNodeType type);
    std::shared_ptr<ASTNode> makeVar(const std::string& name);
    std::shared_ptr<ASTNode> makeNot(std::shared_ptr<ASTNode> child);
    std::shared_ptr<ASTNode> makeAnd(std::shared_ptr<ASTNode> left, std::shared_ptr<ASTNode> right);
    std::shared_ptr<ASTNode> makeOr(std::shared_ptr<ASTNode> left, std::shared_ptr<ASTNode> right);
    std::shared_ptr<ASTNode> makeConst(bool val);

    std::string formatProof(const std::vector<std::pair<std::string, std::string>>& forwardSteps,
                             const std::string& originalTargetStr);
};

} // namespace com::mantiq::logic
