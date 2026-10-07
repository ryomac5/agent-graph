import { resolveProjectLocation, type GitRunner } from "../../../core/src/ledger/repository.ts";

export interface ObservedLocation { cwd: string; repository_id?: string }
/** 観測した場所を、作業ツリーなら本体のリポジトリに結ぶ。git で決まらない場所は場所だけを返す。 */
export type LocationResolver = (cwd: string) => ObservedLocation;

/** リポジトリの識別は導入の対象と同じ規則で、git の共通ディレクトリから決める。同じ場所は一度だけ調べる。 */
export function createLocationResolver(git?: GitRunner): LocationResolver {
  const cache = new Map<string, ObservedLocation>();
  return (cwd) => {
    let location = cache.get(cwd);
    if (!location) {
      const resolved = resolveProjectLocation(cwd, git ? { git } : {});
      // 消えたリポジトリの代わりの識別は、登録したプロジェクトと結べないので記録しない。
      location = resolved.reason === "missing" ? { cwd } : { cwd, repository_id: resolved.repository_id };
      cache.set(cwd, location);
    }
    return location;
  };
}

export const defaultLocationResolver: LocationResolver = createLocationResolver();
