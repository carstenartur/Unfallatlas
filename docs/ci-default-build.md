# Default build contract

The repository-owned default build is:

```bash
mvn -B -ntp clean verify -Ppages
```

GitHub Actions must invoke this command instead of reimplementing frontend, browser, or Analysis Service orchestration in workflow YAML. The same command is intended to run from a normal checkout with JDK 21 and Maven; the Maven reactor installs the pinned Node/npm toolchain and owns the Pages verification lifecycle.

Expensive, externally coupled checks remain opt-in Maven profiles or manually dispatched QA and must not replace the default build contract.
