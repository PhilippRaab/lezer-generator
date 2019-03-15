import {Term, Grammar} from "./grammar/grammar"
import {State, Goto, Reduce} from "./grammar/automaton"

class Frame {
  constructor(readonly prev: Frame | null,
              readonly value: Node | null,
              readonly state: State,
              readonly start: number,
              readonly pos: number) {}

  toString() {
    return this.prev ? `${this.prev} ${this.value} [${this.state.id}]` : `[${this.state.id}]`
  }

  eq(other: Frame): boolean {
    return this.state == other.state && this.pos == other.pos &&
      (this.prev == other.prev || (this.prev && other.prev ? this.prev.eq(other.prev) : false))
  }
}

import {takeFromHeap, addToHeap} from "./heap"

function compareFrames(a: Frame, b: Frame) { return a.pos - b.pos }

function addFrame(heap: Frame[], frame: Frame) {
  if (!heap.some(f => f.eq(frame))) addToHeap(heap, frame, compareFrames)
}

const none: any[] = []

export class Node {
  constructor(readonly name: Term | null,
              readonly length: number,
              readonly children: Node[],
              readonly positions: number[]) {}

  toString() {
    return this.name ? (this.children.length ? this.name + "(" + this.children + ")" : this.name.name) : this.children.join()
  }

  static leaf(name: Term | null, length: number) {
    return new Node(name, length, none, none)
  }

  static of(name: Term | null, children: Node[], positions: number[]) {
    let length = positions[positions.length - 1] + children[children.length - 1].length
    if (children.some(ch => !ch.name)) {
      let flatChildren = [], flatPositions = []
      for (let i = 0; i < children.length; i++) {
        let ch = children[i], pos = positions[i]
        if (ch.name) {
          flatChildren.push(ch)
          flatPositions.push(pos)
        } else {
          for (let j = 0; j < ch.children.length; j++) {
            flatChildren.push(ch.children[j])
            flatPositions.push(pos + ch.positions[j])
          }
        }
      }
      children = flatChildren; positions = flatPositions
    }
    return new Node(name, length, children, positions)
  }

  partial(start: number, end: number, offset: number, target: Node) {
    if (start <= 0 && end >= this.length) {
      target.children.push(this)
      target.positions.push(offset)
    } else {
      for (let i = 0; i < this.children.length; i++) {
        let from = this.positions[i]
        if (from >= end) break
        let child = this.children[i], to = from + child.length
        if (to > start) child.partial(start - from, end - from, offset + from, target)
      }
    }
  }
}

class TreeCursor {
  nodes: Node[]
  start = [0]
  index = [0]

  constructor(node: Node) { this.nodes = [node] }

  // `pos` must be >= any previously given `pos` for this cursor
  nodeAt(pos: number) {
    for (;;) {
      let last = this.nodes.length - 1
      if (last < 0) return null
      let top = this.nodes[last], index = this.index[last]
      if (index == top.children.length) {
        this.nodes.pop()
        this.start.pop()
        this.index.pop()
        continue
      }
      let next = top.children[index]
      let start = this.start[last] + top.positions[index]
      if (start >= pos) return start == pos ? next : null
      this.index[last]++
      if (start + next.length >= pos) { // Enter this node
        this.nodes.push(next)
        this.start.push(start)
        this.index.push(0)
      }
    }
  }
}

export function parse(input: string[], grammar: Grammar, table: State[], cache = Node.leaf(null, 0)): Node {
  let parses = [new Frame(null, null, table[0], 0, 0)]
  let done = null, maxPos = 0
  let cacheIter = new TreeCursor(cache)
  parse: for (; !done;) {
    if (parses.length == 0) throw new Error("NO PARSE @ " + maxPos)
    console.log("stack is " + parses.join(" || "))
    let stack = takeFromHeap(parses, compareFrames), pos = stack.pos
    let next = grammar.terms.get(pos < input.length ? input[pos] : "#")
    console.log("token is", next.name, "@", pos)
    if (!stack.state.ambiguous) {
      for (let cached = cacheIter.nodeAt(pos); cached;
           cached = cached.children.length && cached.positions[0] == 0 ? cached.children[0] : null) {
        let match = stack.state.getGoto(cached.name!)
        if (match) {
          addFrame(parses, new Frame(stack, cached, match.target, pos /* FIXME */, pos + cached.length))
          maxPos = Math.max(maxPos, pos + cached.length)
          console.log("REUSE " + cached, "@", pos, "-", pos + cached.length)
          continue parse
        }
      }
    }

    stack.state.forEachAction(next, action => {
      if (action instanceof Goto) {
        maxPos = Math.max(maxPos, pos + 1)
        addFrame(parses, new Frame(stack, Node.leaf(next, 1), action.target, pos, pos + 1))
      } else if (action instanceof Reduce) {
        let newStack = stack, children = [], positions = []
        for (let i = action.rule.parts.length; i > 0; i--) {
          children.unshift(newStack.value!)
          positions.unshift(newStack.start)
          newStack = newStack.prev!
        }
        let newState = newStack.state.getGoto(action.rule.name)!.target, frame
        if (children.length) {
          let start = positions[0]
          for (let i = 0; i < positions.length; i++) positions[i] -= start
          frame = new Frame(newStack, Node.of(action.rule.name, children, positions), newState, start, pos)
        } else {
          frame = new Frame(newStack, Node.leaf(null, 0), newState, pos, pos)
        }
        addFrame(parses, frame)
      } else { // Accept
        console.log("Success: " + stack.value)
        done = stack.value
      }
    })
  }
  return done
}
