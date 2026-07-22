import { FastifyRequest } from 'fastify';

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  status: string;
  data: T[];
  meta: PaginationMeta;
}

export const parsePagination = (
  request: FastifyRequest,
  defaultSortBy: string = 'createdAt',
  defaultSortOrder: 'asc' | 'desc' = 'desc'
): PaginationParams => {
  const query = request.query as any;

  const page = parseInt(query.page || '1');
  const limit = parseInt(query.limit || '10');
  const sortBy = query.sortBy || defaultSortBy;
  const sortOrder = query.sortOrder === 'asc' ? 'asc' : defaultSortOrder;
  const search = query.search || undefined;

  const validPage = page > 0 ? page : 1;
  const validLimit = limit > 0 ? (limit <= 100 ? limit : 100) : 10; // Cap limit at 100 items

  const skip = (validPage - 1) * validLimit;

  return {
    page: validPage,
    limit: validLimit,
    skip,
    sortBy,
    sortOrder,
    search,
  };
};

export const formatPaginatedResponse = <T>(
  data: T[],
  total: number,
  params: { page: number; limit: number }
): PaginatedResult<T> => {
  const totalPages = Math.ceil(total / params.limit);
  
  return {
    status: 'success',
    data,
    meta: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: totalPages > 0 ? totalPages : 1,
    },
  };
};
