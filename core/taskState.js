'use strict'

/**
 * Tracks the current and most recently interrupted task.
 * Used by gathering, delivery, and tactical decision systems to support
 * resume-after-interrupt patterns.
 *
 * @typedef {Object} TaskDescriptor
 * @property {string} kind          - e.g. 'gather', 'deliver', 'patrol'
 * @property {string} [resource]    - resource type if applicable, e.g. 'wood'
 * @property {Object} [targetPos]   - { x, y, z }
 * @property {string} [targetId]    - block/entity name
 * @property {number} [setAt]       - timestamp when task was set
 * @property {Object} [progress]    - arbitrary progress snapshot
 * @property {string} [interruptionReason]
 * @property {number} [interruptedAt]
 */

class TaskState {
  constructor () {
    /** @type {TaskDescriptor | null} */
    this.currentTask = null
    /** @type {TaskDescriptor | null} */
    this.interruptedTask = null
  }

  /**
   * @param {Omit<TaskDescriptor, 'setAt'>} task
   */
  setCurrentTask (task) {
    if (!task || typeof task !== 'object') {
      this.currentTask = null
      return
    }
    this.currentTask = { ...task, setAt: Date.now() }
  }

  clearCurrentTask () {
    this.currentTask = null
  }

  /**
   * Move current task to interruptedTask with reason.
   * @param {string} reason
   */
  interruptCurrentTask (reason) {
    if (!this.currentTask) return
    this.interruptedTask = {
      ...this.currentTask,
      interruptionReason: String(reason || 'UNKNOWN'),
      interruptedAt: Date.now()
    }
    this.currentTask = null
  }

  /**
   * Restore the interrupted task as current.
   * @returns {TaskDescriptor | null} the restored task, or null if none
   */
  restoreInterruptedTask () {
    if (!this.interruptedTask) return null
    const task = this.interruptedTask
    this.currentTask = task
    this.interruptedTask = null
    return task
  }

  clearInterruptedTask () {
    this.interruptedTask = null
  }

  /** Reset all task state. */
  clear () {
    this.currentTask = null
    this.interruptedTask = null
  }
}

module.exports = { TaskState }
