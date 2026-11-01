import { handleImageDisplay } from '../../src/images/display.js';
import { createImageStore } from '../../src/images/phone.js';

export default {
  fetch(request) {
    return handleImageDisplay(request, {
      getToken: () => process.env.OPERATOR_TOKEN,
      getStore: () => createImageStore({ url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_SECRET_KEY }),
    });
  },
};
