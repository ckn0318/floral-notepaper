/** Priority of a to-do item. "white" is the default / no-priority state; it
 *  drives the colour of the item's rounded checkbox (red / yellow / white). */
export type TodoPriority = "red" | "yellow" | "white";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: TodoPriority;
  pinned: boolean;
}
