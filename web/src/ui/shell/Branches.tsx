import { BranchGraph } from '../branches'

/** The Branches screen (`/branches`): since M15b the Branch Graph, which is also where a new Branch is started. */
export function Branches({ current }: { current: string }) {
  return <BranchGraph current={current} />
}
