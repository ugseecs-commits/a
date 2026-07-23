#include "QuineMcCluskey.h"
#include <sstream>
#include <cmath>
#include <algorithm>
#include <map>

namespace com::mantiq::logic {

template<typename T>
static std::string formatList(const T& container) {
    std::stringstream ss;
    ss << "[";
    bool first = true;
    for (const auto& item : container) {
        if (!first) ss << ", ";
        ss << item;
        first = false;
    }
    ss << "]";
    return ss.str();
}

std::string QuineMcCluskey::Implicant::toString() const {
    std::stringstream ss;
    ss << binary << " " << formatList(minterms);
    return ss.str();
}

std::vector<std::string> QuineMcCluskey::minimize(int numVars, const std::vector<int>& minterms) {
    return minimize(numVars, minterms, {});
}

std::vector<std::string> QuineMcCluskey::minimize(int numVars, const std::vector<int>& minterms, const std::vector<int>& dontCares) {
    return minimizeWithDetails(numVars, minterms, dontCares).solution;
}

QuineMcCluskey::MinimizationResult QuineMcCluskey::minimizeWithDetails(int numVars, const std::vector<int>& minterms, const std::vector<int>& dontCares) {
    std::stringstream steps;
    steps << "=== Quine-McCluskey Minimization ===\n\n";

    if (minterms.empty()) {
        steps << "No minterms provided. Expression simplifies to 0 (or 1 for POS).\n";
        return MinimizationResult({}, {}, {}, {}, steps.str());
    }

    int maxTerms = static_cast<int>(std::pow(2, numVars));
    if (minterms.size() == static_cast<size_t>(maxTerms)) {
        steps << "All possible minterms exist. Expression simplifies to 1 (or 0 for POS).\n";
        std::string allDashes(numVars, '-');
        return MinimizationResult({ allDashes }, { allDashes }, { allDashes }, {{ allDashes }}, steps.str());
    }

    std::set<int> allTerms(minterms.begin(), minterms.end());
    allTerms.insert(dontCares.begin(), dontCares.end());

    steps << "1. Initial Setup\n";
    steps << "   Variables: " << numVars << "\n";
    steps << "   Minterms to cover: " << formatList(minterms) << "\n";
    if (!dontCares.empty()) {
        steps << "   Don't Cares (can be used for grouping): " << formatList(dontCares) << "\n";
    }
    steps << "\n";

    std::vector<Implicant> terms;
    steps << "   Initial Term Binary Representations:\n";
    std::set<int> dontCaresSet(dontCares.begin(), dontCares.end());
    for (int m : allTerms) {
        std::string bin = toBinary(m, numVars);
        terms.push_back(Implicant(bin, { m }));
        steps << "     m" << m << " = " << bin;
        if (dontCaresSet.count(m)) {
            steps << " (d)";
        }
        steps << "\n";
    }
    steps << "\n";

    steps << "2. Finding Prime Implicants (Merging adjacent terms)\n";
    std::string mergeSteps = "";
    std::vector<Implicant> primeImplicants = findPrimeImplicants(terms, mergeSteps);
    steps << mergeSteps;

    std::set<int> mintermSet(minterms.begin(), minterms.end());
    std::vector<Implicant> validPrimeImplicants;
    for (const auto& p : primeImplicants) {
        bool coversMinterm = false;
        for (int m : p.minterms) {
            if (mintermSet.count(m)) {
                coversMinterm = true;
                break;
            }
        }
        if (coversMinterm) {
            validPrimeImplicants.push_back(p);
        }
    }

    steps << "\n3. Filtering & Prime Implicant Dominance\n";
    std::vector<Implicant> nonDominatedPrimes;
    for (size_t i = 0; i < validPrimeImplicants.size(); i++) {
        bool isDominated = false;
        for (size_t j = 0; j < validPrimeImplicants.size(); j++) {
            if (i != j && isSubsumedBy(validPrimeImplicants[i].binary, validPrimeImplicants[j].binary)) {
                isDominated = true;
                steps << "   -> " << validPrimeImplicants[i].binary << " is dominated by " << validPrimeImplicants[j].binary
                      << " (Discarded)\n";
                break;
            }
        }
        if (!isDominated) {
            nonDominatedPrimes.push_back(validPrimeImplicants[i]);
        }
    }

    steps << "\n   Final Valid Prime Implicants:\n";
    std::vector<std::string> allPrimes;
    for (const auto& p : nonDominatedPrimes) {
        allPrimes.push_back(p.binary);
        steps << "     " << p.binary << " covers " << formatList(p.minterms) << "\n";
    }
    steps << "\n";

    steps << "4. Prime Implicant Chart (Coverage Phase)\n";
    std::vector<std::string> essentials;
    std::vector<std::vector<std::string>> allSols;
    std::string coverageSteps = "";
    std::vector<std::string> solution = findMinimalCoverWithEssentials(nonDominatedPrimes, mintermSet, essentials, allSols, coverageSteps);
    steps << coverageSteps;

    steps << "\n=== Final Minimization Result ===\n";
    steps << "Minimized Terms: " << formatList(solution) << "\n";

    return MinimizationResult(allPrimes, essentials, solution, allSols, steps.str());
}

bool QuineMcCluskey::isSubsumedBy(const std::string& a, const std::string& b) {
    if (a.length() != b.length())
        return false;
    int aDashes = 0, bDashes = 0;
    for (size_t i = 0; i < a.length(); i++) {
        char ca = a[i];
        char cb = b[i];
        if (ca == '-') aDashes++;
        if (cb == '-') bDashes++;
        if (ca != '-' && cb != '-' && ca != cb)
            return false;
        if (ca == '-' && cb != '-')
            return false;
    }
    return bDashes > aDashes;
}

std::vector<QuineMcCluskey::Implicant> QuineMcCluskey::findPrimeImplicants(const std::vector<Implicant>& initialTerms, std::string& steps) {
    std::stringstream ss;
    std::vector<Implicant> primeImplicants;
    std::vector<Implicant> currentLevel = initialTerms;
    int pass = 1;

    while (!currentLevel.empty()) {
        ss << "\n   --- Pass " << pass << " (Grouping size " << static_cast<int>(std::pow(2, pass)) << ") ---\n";
        int mergeCount = 0;

        std::set<std::string> mergedBinaries;
        std::vector<Implicant> nextLevel;
        std::vector<bool> wasMerged(currentLevel.size(), false);

        for (size_t i = 0; i < currentLevel.size(); i++) {
            for (size_t j = i + 1; j < currentLevel.size(); j++) {
                std::string merged = tryMerge(currentLevel[i].binary, currentLevel[j].binary);
                if (!merged.empty()) {
                    wasMerged[i] = true;
                    wasMerged[j] = true;
                    if (mergedBinaries.find(merged) == mergedBinaries.end()) {
                        mergedBinaries.insert(merged);

                        std::set<int> combinedMinterms = currentLevel[i].minterms;
                        combinedMinterms.insert(currentLevel[j].minterms.begin(), currentLevel[j].minterms.end());

                        nextLevel.push_back(Implicant(merged, combinedMinterms));
                        ss << "     Merged: " << currentLevel[i].binary << " + "
                           << currentLevel[j].binary << " -> " << merged << "\n";
                        mergeCount++;
                    }
                }
            }
        }

        for (size_t i = 0; i < currentLevel.size(); i++) {
            if (!wasMerged[i]) {
                std::string binaryToCheck = currentLevel[i].binary;
                bool alreadyExists = false;
                for (const auto& p : primeImplicants) {
                    if (p.binary == binaryToCheck) {
                        alreadyExists = true;
                        break;
                    }
                }
                if (!alreadyExists) {
                    primeImplicants.push_back(currentLevel[i]);
                    ss << "     * PI: " << currentLevel[i].binary << " covers " << formatList(currentLevel[i].minterms) << "\n";
                }
            }
        }

        if (mergeCount == 0) {
            ss << "     No more merges possible.\n";
        }
        currentLevel = nextLevel;
        pass++;
    }

    steps = ss.str();
    return primeImplicants;
}

static void findCovers(
    size_t startIndex,
    std::vector<std::string>& currentCover,
    std::set<int>& uncovered,
    const std::vector<std::string>& candidates,
    const std::map<std::string, std::set<int>>& actualCoverage,
    std::vector<std::vector<std::string>>& allCovers
) {
    if (uncovered.empty()) {
        allCovers.push_back(currentCover);
        return;
    }
    if (startIndex >= candidates.size()) {
        return;
    }

    size_t minSize = 999999;
    for (const auto& cov : allCovers) {
        if (cov.size() < minSize) minSize = cov.size();
    }
    if (!allCovers.empty() && currentCover.size() >= minSize) {
        return;
    }

    std::string candidate = candidates[startIndex];
    std::set<int> coveredByThis;
    auto it = actualCoverage.find(candidate);
    if (it != actualCoverage.end()) {
        for (int m : it->second) {
            if (uncovered.count(m)) {
                coveredByThis.insert(m);
            }
        }
    }

    if (!coveredByThis.empty()) {
        currentCover.push_back(candidate);
        for (int m : coveredByThis) uncovered.erase(m);

        findCovers(startIndex + 1, currentCover, uncovered, candidates, actualCoverage, allCovers);

        for (int m : coveredByThis) uncovered.insert(m);
        currentCover.pop_back();
    }

    findCovers(startIndex + 1, currentCover, uncovered, candidates, actualCoverage, allCovers);
}

std::vector<std::string> QuineMcCluskey::findMinimalCoverWithEssentials(
    std::vector<Implicant>& primeImplicants,
    const std::set<int>& mintermsToCover,
    std::vector<std::string>& outEssentials,
    std::vector<std::vector<std::string>>& outAllSolutions,
    std::string& steps
) {
    std::stringstream ss;
    std::vector<std::string> solution;
    std::set<int> uncovered = mintermsToCover;

    for (auto& p : primeImplicants) {
        p.isEssential = false;
    }

    std::map<std::string, std::set<int>> actualCoverage;
    for (const auto& p : primeImplicants) {
        std::set<int> covered;
        for (int m : p.minterms) {
            if (mintermsToCover.count(m)) {
                covered.insert(m);
            }
        }
        actualCoverage[p.binary] = covered;
    }

    ss << "   Finding Essential Prime Implicants:\n";
    bool foundEssential = false;

    for (int m : mintermsToCover) {
        std::vector<std::string> covering;
        for (const auto& p : primeImplicants) {
            if (actualCoverage[p.binary].count(m)) {
                covering.push_back(p.binary);
            }
        }

        if (covering.size() == 1) {
            for (auto& p : primeImplicants) {
                if (p.binary == covering[0] && !p.isEssential) {
                    p.isEssential = true;
                    solution.push_back(p.binary);
                    outEssentials.push_back(p.binary);
                    for (int covM : actualCoverage[p.binary]) {
                        uncovered.erase(covM);
                    }
                    ss << "     -> '" << p.binary << "' is essential (only one covering m" << m << ")\n";
                    foundEssential = true;
                    break;
                }
            }
        }
    }

    if (!foundEssential) {
        ss << "     No essential prime implicants found.\n";
    }

    std::vector<std::string> candidates;
    for (const auto& p : primeImplicants) {
        if (!p.isEssential) {
            candidates.push_back(p.binary);
        }
    }

    std::vector<std::vector<std::string>> allCovers;
    std::vector<std::string> currentCover = solution;

    findCovers(0, currentCover, uncovered, candidates, actualCoverage, allCovers);

    size_t minSize = 999999;
    for (const auto& cov : allCovers) {
        if (cov.size() < minSize) minSize = cov.size();
    }

    outAllSolutions.clear();
    for (const auto& cov : allCovers) {
        if (cov.size() == minSize) {
            auto sorted = cov;
            std::sort(sorted.begin(), sorted.end());
            if (std::find(outAllSolutions.begin(), outAllSolutions.end(), sorted) == outAllSolutions.end()) {
                outAllSolutions.push_back(sorted);
            }
        }
    }

    if (outAllSolutions.empty()) {
        outAllSolutions.push_back(solution);
    }

    solution = outAllSolutions[0];

    ss << "\n   Solutions found: " << outAllSolutions.size() << "\n";
    for (size_t i = 0; i < outAllSolutions.size(); i++) {
        ss << "     Solution " << (i + 1) << ": " << formatList(outAllSolutions[i]) << "\n";
    }

    steps = ss.str();
    return solution;
}

std::string QuineMcCluskey::toBinary(int n, int numVars) {
    std::string result = "";
    for (int i = numVars - 1; i >= 0; i--) {
        result += ((n >> i) & 1) ? '1' : '0';
    }
    return result;
}

std::string QuineMcCluskey::tryMerge(const std::string& a, const std::string& b) {
    if (a.length() != b.length()) return "";

    int diff = 0;
    std::string result = a;

    for (size_t i = 0; i < a.length(); i++) {
        if (a[i] != b[i]) {
            if (++diff > 1) return "";
            result[i] = '-';
        }
    }
    return diff == 1 ? result : "";
}

} // namespace com::mantiq::logic
