'use strict';

const empty = () => [];
const none = async () => ({ messages: [] });

module.exports = {
  listSessions: empty,
  readSession: none,
  listSubagents: empty,
  readSubagent: () => null,
  deleteSession: async () => false,
};
