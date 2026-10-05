import type { Route } from "../route.ts";
import { actionRoute } from "./action.ts";
import { eventsRoute } from "./events.ts";
import { graphRoute } from "./graph.ts";
import { observeRoute } from "./observe.ts";
import { overviewRoute } from "./overview.ts";
import { projectRoute } from "./project.ts";
import { reposRoute } from "./repos.ts";
import { sayRoute } from "./say.ts";
import { sessionsEndRoute } from "./sessions-end.ts";
import { sessionsRoute } from "./sessions.ts";
import { turnsRoute } from "./turns.ts";

// 経路を足すときは、routes/ にファイルを置いてここに 1 行足す。先頭から順に照合する。
export const routes: Route[] = [
  overviewRoute,
  projectRoute,
  eventsRoute,
  actionRoute,
  sessionsRoute,
  sessionsEndRoute,
  observeRoute,
  reposRoute,
  sayRoute,
  graphRoute,
  turnsRoute,
];
