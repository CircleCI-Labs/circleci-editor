/**
 * A small hand-written fixture for the mutation-layer tests: comments (both
 * a leading file-level note and a "section header" before the deploy job),
 * an imported orb, and a workflow with `name:`-aliased entries sharing one
 * underlying job plus a multi-source `requires:` chain -- the shapes
 * `configMutations.ts` has to treat carefully (see its module doc).
 */
export const MUTATION_FIXTURE = `# This config builds, tests, and deploys the widgets service.
# Owned by #platform-eng.
version: 2.1

orbs:
  node: circleci/node@5.2.0

jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: make build

  test:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: make test
      # cleanup after tests
      - run: make clean

  # Deploy jobs
  # These only run against main.

  deploy:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
      - run: make deploy

workflows:
  build_test_deploy:
    jobs:
      - build
      - test:
          name: test-linux
          requires:
            - build
      - test:
          name: test-macos
          requires:
            - build
      - deploy:
          requires:
            - test-linux
            - test-macos
`;
