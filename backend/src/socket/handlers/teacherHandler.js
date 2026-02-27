const pollService = require('../../services/pollService');
const studentService = require('../../services/studentService');
const stateService = require('../../services/stateService');
const timerService = require('../../services/timerService');
const { SOCKET_EVENTS } = require('../../utils/constants');
const { createErrorResponse, createSuccessResponse, generateSessionId } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const Session = require('../../models/Session');

class TeacherHandler {

  async handleTeacherJoin(socket, io, data, callback) {
    try {
      const { sessionId: existingSessionId } = data || {};

      let finalSessionId = existingSessionId || generateSessionId();
      let mongoSession;

      // Try to find by provided session id
      if (existingSessionId) {
        mongoSession = await Session.findOne({ sessionId: existingSessionId, isActive: true });
      }

      // Fallback to socket id
      if (!mongoSession) {
        mongoSession = await Session.findOne({ 'teacherInfo.socketId': socket.id, isActive: true });
      }

      if (mongoSession) {
        finalSessionId = mongoSession.sessionId;
        mongoSession.teacherInfo.socketId = socket.id;
        mongoSession.teacherInfo.lastSeen = new Date();
        await mongoSession.save();
        logger.info(`MongoDB session updated for teacher: ${socket.id}`);
      } else {
        mongoSession = await Session.create({
          sessionId: finalSessionId,
          teacherInfo: {
            socketId: socket.id,
            joinedAt: new Date(),
            lastSeen: new Date(),
          },
          isActive: true,
        });
        logger.info(`MongoDB session created for teacher: ${socket.id}`);
      }

      // Set teacher session in StateService
      const sessionData = {
        socketId: socket.id,
        joinedAt: new Date().toISOString(),
        sessionId: finalSessionId,
        isOnline: true,
      };

      await stateService.setTeacherSession(sessionData);

      // Join teacher room
      socket.join('teacher_room');
      socket.join('main_room'); // IMPORTANT: Teacher must join main_room to see chat and poll updates

      logger.info(`Teacher joined: ${socket.id}`);

      if (callback) {
        callback(createSuccessResponse({
          sessionId: mongoSession.sessionId,
          teacherInfo: sessionData,
        }, 'Teacher joined successfully'));
      }

    } catch (error) {
      logger.error('Error handling teacher join:', error);
      if (callback) {
        callback(createErrorResponse('Failed to join as teacher', 'TEACHER_JOIN_ERROR'));
      }
    }
  }

  async handleCreatePoll(socket, io, data, callback) {
    try {
      const { question, options, duration = 60, sessionId: providedSessionId } = data;

      // Get the current session for this teacher
      const mongoSession = await Session.findOne({ 'teacherInfo.socketId': socket.id, isActive: true });
      const sessionId = providedSessionId || (mongoSession ? mongoSession.sessionId : undefined);

      // Create poll with the correct sessionId
      const result = await pollService.createPoll({ question, options, duration, sessionId }, socket.id);

      // Start timer
      timerService.startTimer(
        result.poll._id.toString(),
        duration,
        (timeRemaining) => {
          // Broadcast timer updates
          io.to('main_room').emit(SOCKET_EVENTS.TIMER_UPDATE, timeRemaining);
        },
        async () => {
          // Auto-end poll when timer expires
          try {
            const endResult = await pollService.endPoll(result.poll._id.toString(), socket.id);

            io.to('main_room').emit(SOCKET_EVENTS.POLL_ENDED, {
              poll: endResult.poll,
              finalResults: endResult.finalResults,
              reason: 'Time expired',
            });

            // Reset all students' vote status
            await studentService.resetStudentsVoteStatus();

          } catch (error) {
            logger.error('Error auto-ending poll:', error);
          }
        }
      );

      // Broadcast poll to all clients
      const pollData = {
        id: result.poll._id.toString(),
        question: result.poll.question,
        options: result.poll.options,
        duration: result.poll.duration,
        startTime: result.poll.startedAt,
      };

      io.to('main_room').emit(SOCKET_EVENTS.POLL_STARTED, pollData);

      logger.info(`Poll created and broadcasted: ${result.poll._id}`);

      if (callback) {
        callback(createSuccessResponse(result, 'Poll created successfully'));
      }

    } catch (error) {
      logger.error('Error creating poll:', error);
      if (callback) {
        callback(createErrorResponse(error.message || 'Failed to create poll', 'POLL_CREATE_ERROR'));
      }
    }
  }

  async handleEndPoll(socket, io, data, callback) {
    try {
      // Get current active poll
      const activePoll = await stateService.getActivePoll();
      if (!activePoll) {
        if (callback) {
          callback(createErrorResponse('No active poll found', 'NO_ACTIVE_POLL'));
        }
        return;
      }

      // End the poll
      const result = await pollService.endPoll(activePoll.id, socket.id);

      // Stop timer
      timerService.stopTimer(activePoll.id);

      // Broadcast poll ended
      io.to('main_room').emit(SOCKET_EVENTS.POLL_ENDED, {
        poll: result.poll,
        finalResults: result.finalResults,
        reason: 'Ended by teacher',
      });

      // Reset all students' vote status
      await studentService.resetStudentsVoteStatus();

      logger.info(`Poll ended by teacher: ${activePoll.id}`);

      if (callback) {
        callback(createSuccessResponse(result, 'Poll ended successfully'));
      }

    } catch (error) {
      logger.error('Error ending poll:', error);
      if (callback) {
        callback(createErrorResponse(error.message || 'Failed to end poll', 'POLL_END_ERROR'));
      }
    }
  }

  async handleKickStudent(socket, io, data, callback) {
    try {
      const { studentName } = data;

      if (!studentName) {
        if (callback) {
          callback(createErrorResponse('Student name is required', 'INVALID_DATA'));
        }
        return;
      }

      // Verify the requester is the teacher
      const teacherSession = await stateService.getTeacherSession();
      if (!teacherSession || teacherSession.socketId !== socket.id) {
        if (callback) {
          callback(createErrorResponse('Unauthorized to kick students', 'UNAUTHORIZED'));
        }
        return;
      }

      // Kick student
      const result = await studentService.kickStudent(studentName, socket.id);

      // Find and disconnect the student's socket
      const connectedSockets = await io.in('main_room').fetchSockets();
      const studentSocket = connectedSockets.find(s => s.id === result.kickedStudent?.socketId);

      if (studentSocket) {
        // Send the kicked event to the specific student BEFORE disconnecting them
        studentSocket.emit('student:kicked', {
          reason: 'Removed by teacher',
        });

        // Wait a short time to ensure the event is received
        setTimeout(() => {
          studentSocket.disconnect(true);
        }, 500);
      }

      // Broadcast updated student list to all remaining clients
      io.to('main_room').emit('students:updated', result.connectedStudents);

      logger.info(`Student kicked: ${studentName} by teacher ${socket.id}`);

      if (callback) {
        callback(createSuccessResponse(result, 'Student kicked successfully'));
      }

    } catch (error) {
      logger.error('Error kicking student:', error);
      if (callback) {
        callback(createErrorResponse(error.message || 'Failed to kick student', 'KICK_STUDENT_ERROR'));
      }
    }
  }

  async handleTeacherDisconnection(socket, io) {
    try {
      // End any active polls
      const activePoll = await stateService.getActivePoll();
      if (activePoll) {
        // Auto-end the poll
        const pollService = require('../../services/pollService');
        await pollService.endPoll(activePoll.id, socket.id);

        io.to('main_room').emit('poll:ended', {
          reason: 'Teacher disconnected',
        });
      }

      // Clear teacher session
      await stateService.clearTeacherSession();

      // Let students know the teacher has disconnected
      io.to('main_room').emit('teacher:disconnected', {
        message: 'The teacher has disconnected. Session will continue in view-only mode.'
      });

    } catch (error) {
      logger.error('Error handling teacher disconnection:', error);
    }
  }

  async handleGetHistory(socket, io, data, callback) {
    try {
      const { limit = 10, sessionId } = data;
      let pollHistory;
      if (sessionId) {
        pollHistory = await pollService.getPollHistoryBySessionId(sessionId, limit);
      } else {
        pollHistory = await pollService.getPollHistory(socket.id, limit);
      }
      if (callback) {
        callback(createSuccessResponse({
          polls: pollHistory,
          total: pollHistory.length,
        }, 'Poll history retrieved successfully'));
      }
    } catch (error) {
      logger.error('Error getting poll history:', error);
      if (callback) {
        callback(createErrorResponse('Failed to get poll history', 'HISTORY_ERROR'));
      }
    }
  }
}

module.exports = new TeacherHandler(); 
