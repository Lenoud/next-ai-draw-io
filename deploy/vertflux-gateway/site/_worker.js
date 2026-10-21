export default {
  async fetch(request, env) {
    return env.DRAW_APP.fetch(request);
  },
};
