// The seed every property test in core runs with, so a failure reproduces exactly. fast-check
// also prints the seed and the shrunk counterexample of any failure. Change it deliberately to
// explore other inputs; never to make a failure go away.
export const PROPERTY_SEED = 20_261_104;
