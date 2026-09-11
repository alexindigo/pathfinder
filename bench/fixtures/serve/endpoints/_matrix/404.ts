// SPDX-License-Identifier: LGPL-3.0-only

// Leafless-dir outcome: _matrix holds only this 404 (no route file at its
// level) — exercises the anchor machinery for deep no-matches. The page
// asserts the subtree's identity (M_UNRECOGNIZED) so the harness's
// correctness probe can prove the leafless-dir anchor fired (a root/Layer-0
// default would render {"detail"} instead).
import { json } from "../../../../../src/response.ts";

export default (_request, context) => {
  const miss = context.miss;
  return json({
    errcode: "M_UNRECOGNIZED",
    error: "Unrecognized request",
    rest: miss?.kind === "no-match" ? miss.rest : "",
  }, { status: 404 });
};
