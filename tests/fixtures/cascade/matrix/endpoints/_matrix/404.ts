import { json } from "../../../../../../src/response.ts";

export default (
  _request: unknown,
  context: { miss?: { kind: string; rest?: string } },
) => {
  const miss = context.miss;
  return json({
    errcode: "M_UNRECOGNIZED",
    error: "Unrecognized request",
    rest: miss?.kind === "no-match" ? miss.rest : "",
  }, { status: 404 });
};
