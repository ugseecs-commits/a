#pragma once
#include <string>
#include <vector>
#include <set>

namespace com::mantiq::logic {

class QuineMcCluskey {
public:
    struct MinimizationResult {
        std::vector<std::string> primeImplicants;
        std::vector<std::string> essentialPrimeImplicants;
        std::vector<std::string> solution;
        std::vector<std::vector<std::string>> allSolutions;
        std::string stepsLog;

        MinimizationResult() = default;
        MinimizationResult(const std::vector<std::string>& primes,
                           const std::vector<std::string>& essentials,
                           const std::vector<std::string>& sol,
                           const std::vector<std::vector<std::string>>& allSols,
                           const std::string& log)
            : primeImplicants(primes), essentialPrimeImplicants(essentials), solution(sol), allSolutions(allSols), stepsLog(log) {}
    };

private:
    struct Implicant {
        std::string binary;
        std::set<int> minterms;
        bool isEssential = false;

        Implicant(const std::string& bin, const std::set<int>& mints)
            : binary(bin), minterms(mints) {}

        std::string toString() const;
    };

    static std::string toBinary(int n, int numVars);
    static std::string tryMerge(const std::string& a, const std::string& b);
    static bool isSubsumedBy(const std::string& a, const std::string& b);
    static std::vector<Implicant> findPrimeImplicants(const std::vector<Implicant>& initialTerms, std::string& steps);
    static std::vector<std::string> findMinimalCoverWithEssentials(
        std::vector<Implicant>& primeImplicants,
        const std::set<int>& mintermsToCover,
        std::vector<std::string>& outEssentials,
        std::vector<std::vector<std::string>>& outAllSolutions,
        std::string& steps
    );

public:
    static std::vector<std::string> minimize(int numVars, const std::vector<int>& minterms);
    static std::vector<std::string> minimize(int numVars, const std::vector<int>& minterms, const std::vector<int>& dontCares);
    static MinimizationResult minimizeWithDetails(int numVars, const std::vector<int>& minterms, const std::vector<int>& dontCares);
};

} // namespace com::mantiq::logic
