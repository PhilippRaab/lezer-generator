import {Term, TermSet, Rule, precedenceValue, precedenceAssoc, PREC_REPEAT, ASSOC_LEFT, cmpSet} from "./grammar"

export class Pos {
  hash: number

  constructor(readonly rule: Rule,
              readonly pos: number,
              readonly ahead: ReadonlyArray<Term>,
              readonly prev: Pos | null) {
    let h = hash(rule.id, pos)
    for (let a of this.ahead) h = hash(h, a.hash)
    this.hash = h
  }

  get next() {
    return this.pos < this.rule.parts.length ? this.rule.parts[this.pos] : null
  }

  advance() {
    return new Pos(this.rule, this.pos + 1, this.ahead, this)
  }

  cmp(pos: Pos) {
    return this.cmpSimple(pos) || cmpSet(this.ahead, pos.ahead, (a, b) => a.cmp(b))
  }

  cmpSimple(pos: Pos) {
    return this.rule.cmp(pos.rule) || this.pos - pos.pos
  }

  toString() {
    let parts = this.rule.parts.map(t => t.name)
    parts.splice(this.pos, 0, "·")
    return `${this.rule.name} -> ${parts.join(" ")}`
  }

  eq(other: Pos) {
    return this == other ||
      this.hash == other.hash && this.rule == other.rule && this.pos == other.pos &&
      sameSet(this.ahead, other.ahead)
  }

  trail() {
    let result = []
    for (let cur = this.prev; cur; cur = cur.prev) result.push(cur.next)
    return result.join(" ")
  }
}

function termsAhead(rule: Rule, pos: number, after: ReadonlyArray<Term>, first: {[name: string]: Term[]}): Term[] {
  let found: Term[] = []
  for (let i = pos + 1; i < rule.parts.length; i++) {
    let next = rule.parts[i], cont = false
    if (next.terminal) {
      if (!found.includes(next)) found.push(next)
    } else for (let term of first[next.name]) {
      if (term == null) cont = true
      else if (!found.includes(term)) found.push(term)
    }
    if (!cont) return found
  }
  for (let a of after) addTo(a, found)
  return found
}

function eqSet<T extends {eq(other: T): boolean}>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

function sameSet<T>(a: readonly T[], b: readonly T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
  return true
}

export class Shift {
  constructor(readonly term: Term, readonly target: State) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Shift && other.target == this.target }

  toString() { return "s" + this.target.id }

  map(mapping: number[], states: State[]) { return new Shift(this.term, states[mapping[this.target.id]]) }
}

export class Reduce {
  constructor(readonly term: Term, readonly rule: Rule) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Reduce && other.rule == this.rule }

  toString() { return `${this.rule.name.name}(${this.rule.parts.length})` }

  map() { return this }
}

const ACCEPTING = 1 /*FIXME unused*/, AMBIGUOUS = 2 // FIXME maybe store per terminal

function hashPositions(set: ReadonlyArray<Pos>) {
  let h = 5381
  for (let pos of set) h = hash(h, pos.hash)
  return h
}

export class State {
  actions: (Shift | Reduce)[] = []
  actionPositions: (readonly Pos[])[] = []
  goto: Shift[] = []
  recover: Shift[] = []
  hash: number

  constructor(readonly id: number, readonly set: ReadonlyArray<Pos>, public flags = 0) {
    this.hash = hashPositions(set)
  }

  get ambiguous() { return (this.flags & AMBIGUOUS) > 0 }
  get accepting() { return (this.flags & ACCEPTING) > 0 }

  toString() {
    let actions = this.actions.map(t => t.term + "=" + t).join(",") +
      (this.goto.length ? " | " + this.goto.map(g => g.term + "=" + g).join(",") : "")
    return this.id + ": " + this.set.filter(p => p.pos > 0).join() + (actions.length ? "\n  " + actions : "")
  }

  addActionInner(value: Shift | Reduce, positions: readonly Pos[]): Shift | Reduce | null {
    function precFor(action: Shift | Reduce, positions: readonly Pos[]): number {
      return action instanceof Reduce ? positions[0].rule.rulePrecedence
        : positions.reduce((prec, pos) => Math.max(prec, pos.rule.posPrecedence[pos.pos]), 0)
    }

    check: for (let i = 0; i < this.actions.length; i++) {
      let action = this.actions[i]
      if (action.term == value.term) {
        if (action.eq(value)) return null
        let prec = precFor(value, positions)
        if (precedenceValue(prec) != PREC_REPEAT) this.flags |= AMBIGUOUS
        let prevPositions = this.actionPositions[i]
        if (positions[0].rule.conflictGroups.some(group => prevPositions.every(pos => pos.rule.conflictGroups.includes(group))))
          continue check
        let prevPrec = precFor(action, prevPositions)
        let diff = precedenceValue(prec) - precedenceValue(prevPrec)
        if (diff == 0 && precedenceAssoc(prec))
          diff = precedenceAssoc(prec) == ASSOC_LEFT ? 1 : -1
        if (diff > 0) { // Drop the existing action
          this.actions.splice(i, 1)
          this.actionPositions.splice(i, 1)
          i--
          continue check
        } else if (diff < 0) { // Drop this one
          return null
        } else { // Not resolved
          return action
        }
      }
    }
    this.actions.push(value)
    this.actionPositions.push(positions)
    return null
  }

  addAction(value: Shift | Reduce, positions: readonly Pos[]) {
    let conflict = this.addActionInner(value, positions)
    if (conflict) {
      let conflictPos = this.actionPositions[this.actions.indexOf(conflict)][0]
      let error
      if (conflict instanceof Shift)
        error = `shift/reduce conflict between ${conflictPos} and ${positions[0].rule}`
      else
        error = `reduce/reduce conflict between ${positions[0].rule} and ${conflictPos.rule}`
      let trail = positions[0].trail()
      if (trail.length > 50) trail = trail.slice(trail.length - 50).replace(/.*? /, "… ")
      error += `\nAfter input:\n  ${trail} · ${value.term} …`
      throw new Error(error)
    }
  }

  getGoto(term: Term) {
    return this.goto.find(a => a.term == term)
  }

  hasSet(set: ReadonlyArray<Pos>) {
    return eqSet(this.set, set)
  }
}

class AddedPos {
  constructor(readonly rule: Rule, readonly ahead: Term[], readonly origIndex: number, readonly prev: Pos | null) {}
}

function closure(set: ReadonlyArray<Pos>, rules: ReadonlyArray<Rule>, first: {[name: string]: Term[]}) {
  let added: AddedPos[] = [], redo: AddedPos[] = []
  function addFor(name: Term, ahead: ReadonlyArray<Term>, prev: Pos | null) {
    for (let rule of rules) if (rule.name == name) {
      let add = added.find(a => a.rule == rule)
      if (!add) {
        let existing = set.findIndex(p => p.pos == 0 && p.rule == rule)
        add = new AddedPos(rule, existing < 0 ? [] : set[existing].ahead.slice(), existing, prev)
        added.push(add)
      }
      for (let term of ahead) if (!add.ahead.includes(term)) {
        add.ahead.push(term)
        if (add.rule.parts.length && !add.rule.parts[0].terminal) addTo(add, redo)
      }
    }
  }
  
  for (let pos of set) {
    let next = pos.next
    if (next && !next.terminal) addFor(next, termsAhead(pos.rule, pos.pos, pos.ahead, first), pos.prev)
  }
  while (redo.length) {
    let add = redo.pop()!
    addFor(add.rule.parts[0], termsAhead(add.rule, 0, add.ahead, first), add.prev)
  }

  let result = set.slice()
  for (let add of added) {
    let pos = new Pos(add.rule, 0, add.ahead.sort((a, b) => a.hash - b.hash), add.prev)
    if (add.origIndex > -1) result[add.origIndex] = pos
    else result.push(pos)
  }
  return result.sort((a, b) => a.cmp(b))
}

function addTo<T>(value: T, array: T[]) {
  if (!array.includes(value)) array.push(value)
}

function computeFirst(rules: ReadonlyArray<Rule>, nonTerminals: Term[]) {
  let table: {[term: string]: Term[]} = {}
  for (let t of nonTerminals) table[t.name] = []
  for (;;) {
    let change = false
    for (let rule of rules) {
      let set = table[rule.name.name]
      let found = false, startLen = set.length
      for (let part of rule.parts) {
        found = true
        if (part.terminal) {
          addTo(part, set)
        } else {
          for (let t of table[part.name]) {
            if (t == null) found = false
            else addTo(t, set)
          }
        }
        if (found) break
      }
      if (!found) addTo(null, set)
      if (set.length > startLen) change = true
    }
    if (!change) return table
  }
}

function findState(states: ReadonlyArray<State>, set: ReadonlyArray<Pos>) {
  let hash = hashPositions(set)
  for (let state of states) if (state.hash == hash && state.hasSet(set)) return state
  return null
}

// Builds a full LR(1) automaton
export function buildFullAutomaton(rules: ReadonlyArray<Rule>, terms: TermSet, first: {[name: string]: Term[]}) {
  let states: State[] = []
  function explore(set: ReadonlyArray<Pos>) {
    if (set.length == 0) return null
    set = closure(set, rules, first)
    let state = findState(states, set)
    if (!state) {
      states.push(state = new State(states.length, set))
      for (let term of terms.terminals) if (!term.eof && !term.error) {
        let relevant = set.filter(pos => pos.next == term)
        if (relevant.length) {
          let next = explore(relevant.map(pos => pos.advance()))
          if (next) state.addAction(new Shift(term, next), relevant)
        }
      }
      for (let nt of terms.nonTerminals) {
        let goto = explore(set.filter(pos => pos.next == nt).map(pos => pos.advance()))
        if (goto) state.goto.push(new Shift(nt, goto))
      }
      let program = state.set.findIndex(pos => pos.pos == 0 && pos.rule.name.program)
      if (program > -1) {
        let accepting = new State(states.length, none, ACCEPTING)
        states.push(accepting)
        state.goto.push(new Shift(state.set[program].rule.name, accepting))
      }
      for (let pos of set) if (pos.next == null) for (let ahead of pos.ahead)
        state.addAction(new Reduce(ahead, pos.rule), [pos])
    }
    return state
  }

  explore(rules.filter(rule => rule.name.name == "program").map(rule => new Pos(rule, 0, [terms.eof], null)))
  return states
}

function mergeState(mapping: number[], newStates: State[], state: State, target: State): boolean {
  for (let j = 0; j < state.actions.length; j++)
    if (target.addActionInner(state.actions[j].map(mapping, newStates), state.actionPositions[j]))
      return false
  for (let goto of state.goto) {
    if (!target.goto.find(a => a.term == goto.term))
      target.goto.push(goto.map(mapping, newStates))
  }
  return true
}

function markConflicts(mapping: number[], newID: number, oldStates: State[], newStates: State[], conflicts: number[]) {
  // For all combinations of merged states
  for (let i = 0; i < mapping.length; i++) if (mapping[i] == newID) {
    for (let j = 0; j < mapping.length; j++) if (j != i && mapping[j] == newID) {
      // Create a dummy state to determine whether there's a conflict
      let state = new State(0, none)
      mergeState(mapping, newStates, oldStates[i], state)
      if (!mergeState(mapping, newStates, oldStates[j], state)) conflicts.push(i, j)
    }
  }
}

function hasConflict(id: number, newID: number, mapping: number[], conflicts: number[]) {
  for (let i = 0; i < conflicts.length; i++) if (conflicts[i] == id) {
    let other = conflicts[i + (i % 2 ? -1 : 1)] // Pick other side of the pair
    if (mapping[other] == newID) return true
  }
  return false
}

// Collapse an LR(1) automaton to an LALR-like automaton
function collapseAutomaton(states: State[]): State[] {
  let conflicts: number[] = []
  for (;;) {
    let newStates: State[] = [], mapping: number[] = []
    for (let i = 0; i < states.length; i++) {
      let state = states[i], set: Pos[] = []
      for (let pos of state.set) if (!set.some(p => p.cmpSimple(pos) == 0)) set.push(pos)
      let newID = newStates.findIndex((s, index) => {
        return cmpSet(s.set, set, (a, b) => a.cmpSimple(b)) == 0 &&
          !hasConflict(i, index, mapping, conflicts)
      })
      if (newID < 0) {
        newID = newStates.length
        newStates.push(new State(newID, set, state.flags))
      } else {
        newStates[newID].flags |= state.flags
      }
      mapping.push(newID)
    }
    let conflicting: number[] = []
    for (let i = 0; i < states.length; i++) {
      let newID = mapping[i]
      if (conflicting.includes(newID)) continue // Don't do work for states that are known to conflict
      if (!mergeState(mapping, newStates, states[i], newStates[mapping[i]])) {
        conflicting.push(newID)
        markConflicts(mapping, newID, states, newStates, conflicts)
      }
    }
    if (!conflicting.length) return newStates
  }
}

const none: ReadonlyArray<any> = []

function addRecoveryRules(table: State[], rules: ReadonlyArray<Rule>, first: {[name: string]: Term[]}) {
  for (let state of table) {
    for (let pos of state.set) if (pos.pos > 0) {
      for (let i = pos.pos + 1; i < pos.rule.parts.length; i++) {
        let part = pos.rule.parts[i]
        terms: for (let term of (part.terminal ? [part] : first[part.name])) if (term && !state.recover.some(a => a.term == term)) {
          let next = pos.rule.parts[pos.pos]
          let action = next.terminal ? state.actions.find(t => t.term == next) : state.getGoto(next)
          if (!action || !(action instanceof Shift)) continue
          state.recover.push(new Shift(term, action.target))
        }
      }
    }
  }
}

export function buildAutomaton(rules: ReadonlyArray<Rule>, terms: TermSet) {
  let first = computeFirst(rules, terms.nonTerminals)
  let table = collapseAutomaton(buildFullAutomaton(rules, terms, first))
  addRecoveryRules(table, rules, first)
  return table
}

function hash(a: number, b: number): number { return (a << 5) + a + b }
