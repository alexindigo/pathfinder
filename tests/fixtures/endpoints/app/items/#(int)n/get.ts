export default (request: { params: { n: string } }) => ({
  n: String(request.params.n),
});
