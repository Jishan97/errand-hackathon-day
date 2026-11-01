import { handleImageGeneration } from '../../src/images/generate.js';

export default {
  fetch(request) {
    return handleImageGeneration(request, {
      getToken: () => process.env.OPERATOR_TOKEN,
      getConfig: () => ({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_IMAGE_MODEL || undefined }),
    });
  },
};
