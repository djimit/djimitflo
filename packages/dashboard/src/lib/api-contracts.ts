import type { ContractKeys } from '@djimitflo/shared';
import type { DraftPrs, EfficiencyView, EvolutionEvidence, OperatorCockpit, OperatorDigest, RuntimeHealthRow } from './api';

/**
 * UX-2b: compile-time check that the dashboard's response types name exactly the keys the server returns
 * (packages/shared/src/contracts/operator.ts; the server's operator-contracts test pins the other side).
 * A key added or dropped on one side without the other fails `npm run type-check` here.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type OperatorApiContractChecks = [
  Assert<Same<keyof OperatorCockpit, ContractKeys<'cockpit'>>>,
  Assert<Same<keyof EvolutionEvidence, ContractKeys<'evolutionEvidence'>>>,
  Assert<Same<keyof RuntimeHealthRow, ContractKeys<'runtimeRow'>>>,
  Assert<Same<'runtimes', ContractKeys<'runtimes'>>>,
  Assert<Same<keyof OperatorDigest, ContractKeys<'digest'>>>,
  Assert<Same<keyof DraftPrs, ContractKeys<'draftPrs'>>>,
  Assert<Same<keyof DraftPrs['rows'][number], ContractKeys<'draftPrRow'>>>,
  Assert<Same<keyof EfficiencyView, ContractKeys<'efficiency'>>>,
];
