'use strict';

const { discoverProviders, normalizeProviderId } = require('./providers');

function discoverModelProviders(opts = {}) {
  return discoverProviders(opts);
}

function normalizeActiveProvider(value) {
  return normalizeProviderId(value);
}

module.exports = {
  discoverModelProviders,
  normalizeActiveProvider,
};
