const { SESSION_TIMEOUT } = require('../utils/constants');
const logger = require('../utils/logger');

class StateService {
  constructor() {
    this.state = {
      activePoll: null,
      pollVotes: new Map(), // Error handled per poll ID: { option1: 0, option2: 0 }
      pollVoters: new Map(), // Set of student names per poll ID
      connectedStudents: new Map(), // socketId -> student data
      teacherSession: null
    };

    this.timeouts = {
      activePoll: null,
      pollVotes: new Map(),
      pollVoters: new Map(),
      teacherSession: null
    };
  }

  // Active Poll Management
  async setActivePoll(pollData) {
    try {
      this.state.activePoll = typeof pollData === 'string' ? JSON.parse(pollData) : pollData;
      
      if (this.timeouts.activePoll) {
        clearTimeout(this.timeouts.activePoll);
      }
      this.timeouts.activePoll = setTimeout(() => {
        this.clearActivePoll();
      }, SESSION_TIMEOUT * 1000);

      logger.info(`Active poll set: ${pollData.id}`);
    } catch (error) {
      logger.error('Error setting active poll:', error);
      throw error;
    }
  }

  async getActivePoll() {
    try {
      return this.state.activePoll;
    } catch (error) {
      logger.error('Error getting active poll:', error);
      return null;
    }
  }

  async clearActivePoll() {
    try {
      this.state.activePoll = null;
      if (this.timeouts.activePoll) {
        clearTimeout(this.timeouts.activePoll);
        this.timeouts.activePoll = null;
      }
      logger.info('Active poll cleared');
    } catch (error) {
      logger.error('Error clearing active poll:', error);
    }
  }

  // Vote Management
  async initializePollVotes(pollId, options) {
    try {
      const votes = {};
      options.forEach(option => {
        votes[option] = 0;
      });
      this.state.pollVotes.set(pollId, votes);

      if (this.timeouts.pollVotes.has(pollId)) {
        clearTimeout(this.timeouts.pollVotes.get(pollId));
      }
      this.timeouts.pollVotes.set(pollId, setTimeout(() => {
        this.state.pollVotes.delete(pollId);
        this.timeouts.pollVotes.delete(pollId);
      }, SESSION_TIMEOUT * 1000));

      logger.info(`Poll votes initialized for: ${pollId}`);
    } catch (error) {
      logger.error('Error initializing poll votes:', error);
      throw error;
    }
  }

  async incrementVote(pollId, option) {
    try {
      const votes = this.state.pollVotes.get(pollId);
      if (votes && typeof votes[option] !== 'undefined') {
        votes[option] += 1;
        return votes[option];
      }
      return null;
    } catch (error) {
      logger.error('Error incrementing vote:', error);
      throw error;
    }
  }

  async getPollResults(pollId) {
    try {
      return this.state.pollVotes.get(pollId) || {};
    } catch (error) {
      logger.error('Error getting poll results:', error);
      return {};
    }
  }

  async clearPollVotes(pollId) {
    try {
      this.state.pollVotes.delete(pollId);
      this.state.pollVoters.delete(pollId);

      if (this.timeouts.pollVotes.has(pollId)) {
        clearTimeout(this.timeouts.pollVotes.get(pollId));
        this.timeouts.pollVotes.delete(pollId);
      }
      if (this.timeouts.pollVoters.has(pollId)) {
        clearTimeout(this.timeouts.pollVoters.get(pollId));
        this.timeouts.pollVoters.delete(pollId);
      }

      logger.info(`Poll votes cleared for: ${pollId}`);
    } catch (error) {
      logger.error('Error clearing poll votes:', error);
    }
  }

  // Voter Tracking
  async addVoter(pollId, studentName) {
    try {
      if (!this.state.pollVoters.has(pollId)) {
        this.state.pollVoters.set(pollId, new Set());
      }
      this.state.pollVoters.get(pollId).add(studentName);

      if (this.timeouts.pollVoters.has(pollId)) {
        clearTimeout(this.timeouts.pollVoters.get(pollId));
      }
      this.timeouts.pollVoters.set(pollId, setTimeout(() => {
        this.state.pollVoters.delete(pollId);
        this.timeouts.pollVoters.delete(pollId);
      }, SESSION_TIMEOUT * 1000));
    } catch (error) {
      logger.error('Error adding voter:', error);
      throw error;
    }
  }

  async hasVoted(pollId, studentName) {
    try {
      const voters = this.state.pollVoters.get(pollId);
      return voters ? voters.has(studentName) : false;
    } catch (error) {
      logger.error('Error checking if voted:', error);
      return false;
    }
  }

  async getVoterCount(pollId) {
    try {
      const voters = this.state.pollVoters.get(pollId);
      return voters ? voters.size : 0;
    } catch (error) {
      logger.error('Error getting voter count:', error);
      return 0;
    }
  }

  // Student Management
  async addStudent(socketId, studentData) {
    try {
      this.state.connectedStudents.set(socketId, typeof studentData === 'string' ? JSON.parse(studentData) : studentData);
      logger.info(`Student added: ${studentData.name} (${socketId})`);
    } catch (error) {
      logger.error('Error adding student:', error);
      throw error;
    }
  }

  async removeStudent(socketId) {
    try {
      const studentData = this.state.connectedStudents.get(socketId);
      this.state.connectedStudents.delete(socketId);
      
      if (studentData) {
        logger.info(`Student removed: ${studentData?.name || 'Unknown'} (${socketId})`);
      }
    } catch (error) {
      logger.error('Error removing student:', error);
    }
  }

  async getConnectedStudents() {
    try {
      const students = [];
      for (const [socketId, student] of this.state.connectedStudents.entries()) {
        students.push({ ...student, socketId });
      }
      return students;
    } catch (error) {
      logger.error('Error getting connected students:', error);
      return [];
    }
  }

  async isStudentNameTaken(name) {
    try {
      const students = await this.getConnectedStudents();
      return students.some(student => student.name.toLowerCase() === name.toLowerCase());
    } catch (error) {
      logger.error('Error checking student name:', error);
      return false;
    }
  }

  async updateStudentStatus(socketId, updates) {
    try {
      const studentData = this.state.connectedStudents.get(socketId);
      
      if (studentData) {
        const updatedStudent = { ...studentData, ...updates, lastSeen: new Date().toISOString() };
        this.state.connectedStudents.set(socketId, updatedStudent);
      }
    } catch (error) {
      logger.error('Error updating student status:', error);
    }
  }

  // Teacher Session Management
  async setTeacherSession(sessionData) {
    try {
      this.state.teacherSession = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;
      
      if (this.timeouts.teacherSession) {
        clearTimeout(this.timeouts.teacherSession);
      }
      this.timeouts.teacherSession = setTimeout(() => {
        this.clearTeacherSession();
      }, SESSION_TIMEOUT * 1000);

      logger.info(`Teacher session set: ${sessionData.socketId}`);
    } catch (error) {
      logger.error('Error setting teacher session:', error);
      throw error;
    }
  }

  async getTeacherSession() {
    try {
      return this.state.teacherSession;
    } catch (error) {
      logger.error('Error getting teacher session:', error);
      return null;
    }
  }

  async clearTeacherSession() {
    try {
      this.state.teacherSession = null;
      if (this.timeouts.teacherSession) {
        clearTimeout(this.timeouts.teacherSession);
        this.timeouts.teacherSession = null;
      }
      logger.info('Teacher session cleared');
    } catch (error) {
      logger.error('Error clearing teacher session:', error);
    }
  }

  // General cleanup
  async cleanup() {
    try {
      this.state.activePoll = null;
      this.state.pollVotes.clear();
      this.state.pollVoters.clear();
      this.state.connectedStudents.clear();
      this.state.teacherSession = null;

      if (this.timeouts.activePoll) clearTimeout(this.timeouts.activePoll);
      if (this.timeouts.teacherSession) clearTimeout(this.timeouts.teacherSession);
      for (const timeout of this.timeouts.pollVotes.values()) clearTimeout(timeout);
      for (const timeout of this.timeouts.pollVoters.values()) clearTimeout(timeout);
      
      this.timeouts.activePoll = null;
      this.timeouts.teacherSession = null;
      this.timeouts.pollVotes.clear();
      this.timeouts.pollVoters.clear();
      
      logger.info('State cleanup completed');
    } catch (error) {
      logger.error('Error during State cleanup:', error);
    }
  }
}

module.exports = new StateService();
