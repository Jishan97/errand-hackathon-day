import { waitUntil } from '@vercel/functions';
import { createIncidentRuntime, runtimeValues, scheduleIncident } from '../../src/core/runtime.js';
import { handleOperator } from '../../src/core/operator.js';

export default {
  fetch(request) {
    return handleOperator(request, {
      getToken: () => process.env.OPERATOR_TOKEN,
      getRuntime: () => createIncidentRuntime(runtimeValues(process.env)),
      schedule: (runtime, id) => scheduleIncident(runtime, id, waitUntil),
    });
  },
};
