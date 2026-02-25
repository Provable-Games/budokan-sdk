export interface PaginatedResult<T> {
  data: T[];
  total?: number;
  limit: number;
  offset: number;
}
