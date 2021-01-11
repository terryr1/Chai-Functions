const { google } = require("googleapis");
const constants = require("./constants");
const API_KEY = constants.API_KEY;
const DISCOVERY_URL = constants.DISCOVERY_URL;

const getPerspective = async (title) => {
  const client = await google.discoverAPI(DISCOVERY_URL);

  const analyzeRequest = {
    comment: {
      text: title,
    },
    requestedAttributes: {
      TOXICITY: {},
    },
  };

  return client.comments
    .analyze({
      key: API_KEY,
      resource: analyzeRequest,
    })
    .then((response) => response.data)
    .catch((err) => JSON.stringify(err));
};

module.exports = { getPerspective };
