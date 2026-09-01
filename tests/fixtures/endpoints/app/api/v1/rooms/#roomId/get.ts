export default (request: { params: { roomId: string } }) => ({
  roomId: request.params.roomId,
});
