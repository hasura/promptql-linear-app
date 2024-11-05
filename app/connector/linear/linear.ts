
export const LinearSyncSchema = `
  CREATE TABLE IF NOT EXISTS linear_teams (
    id TEXT PRIMARY KEY,
    name TEXT,
    key TEXT,
    description TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
  );

  COMMENT ON COLUMN linear_teams.created_at IS 'This is an ISO formatted timestamp';
  COMMENT ON COLUMN linear_teams.updated_at IS 'This is an ISO formatted timestamp';

  CREATE TABLE IF NOT EXISTS linear_issues (
    id TEXT PRIMARY KEY,
    team_id TEXT,
    title TEXT,
    description TEXT,
    state TEXT,
    priority INTEGER,
    identifier TEXT,
    number INTEGER,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    completed_at TIMESTAMP,
    creator_email TEXT,
    creator_name TEXT,
    assignee_email TEXT,
    assignee_name TEXT,
    bot_type TEXT,
    bot_user TEXT,
    link_type TEXT,
    link_url TEXT,
    labels TEXT,
    FOREIGN KEY(team_id) REFERENCES linear_teams(id),
  );

  COMMENT ON COLUMN linear_issues.created_at IS 'This is an ISO formatted timestamp';
  COMMENT ON COLUMN linear_issues.created_at IS 'This is an ISO formatted timestamp';
  COMMENT ON COLUMN linear_issues.completed_at IS 'This is an ISO formatted timestamp';

  CREATE TABLE IF NOT EXISTS linear_comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT,
    body TEXT,
    user_email TEXT,
    user_name TEXT,
    bot_type TEXT,
    bot_user TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY(issue_id) REFERENCES linear_issues(id)
  );

  COMMENT ON COLUMN linear_comments.created_at IS 'This is an ISO formatted timestamp';
  COMMENT ON COLUMN linear_comments.updated_at IS 'This is an ISO formatted timestamp';

  CREATE TABLE IF NOT EXISTS linear_sync_state (
    team_id TEXT PRIMARY KEY,
    last_issue_sync TIMESTAMP,
    FOREIGN KEY(team_id) REFERENCES linear_teams(id)
  );

  CREATE TABLE IF NOT EXISTS linear_comment_sync_state (
    issue_id TEXT PRIMARY KEY,
    last_comment_sync TIMESTAMP,
    FOREIGN KEY(issue_id) REFERENCES linear_issues(id)
  );
`;

export const teamsQuery = `
  query Teams($after: String) {
    teams (
      first: 30,
      after: $after
    ) {
      nodes {
        id
        name
        key
        description
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const issuesQuery = `
  query TeamIssues($teamId: String!, $after: String, $filter: IssueFilter) {
    team(id: $teamId) {
      issues(
        first: 50,
        after: $after,
        orderBy: updatedAt
        filter: $filter
      ) {
        nodes {
          id
          title
          description
          number
          identifier
          priority
          estimate
          state {
            name
          }
          team {
            id
            name
          }
          project {
            id
            name
          }
          labels (first: 10) {
            nodes {
              name
            }
          }
          creator {
            id
            name
            email
          }
          assignee {
            id
            name
            email
          }
          createdAt
          updatedAt
          completedAt
          botActor {
            name,
            type,
            subType,
            userDisplayName
          }
          attachments (first: 2){
            nodes {
              url
              sourceType
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const commentsQuery = `
  query Comments($after: String, $filter: CommentFilter) {
    comments(
      first: 5,
      after: $after,
      orderBy: updatedAt
      filter: $filter
    ) {
      nodes {
        id
        body
        summaryText
        botActor {
          name
          type
          subType
          userDisplayName
        }
        user {
          name
          email
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface TeamsResponse {
  teams: {
    nodes: LinearTeamResponse[];
  };
}

export interface TeamIssuesResponse {
  team: {
    issues: LinearPaginatedResponse<LinearIssueResponse>;
  };
}

export interface IssueCommentsResponse {
  comments: LinearPaginatedResponse<LinearComment>;
}

export interface LinearGraphQLResponse<T> {
  data: T;
  errors?: Array<{
    message: string;
    locations: Array<{
      line: number;
      column: number;
    }>;
    path: string[];
  }>;
}

export interface LinearPaginatedResponse<T> {
  nodes: T[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string;
  };
}

export interface LinearState {
  name: string;
}

export interface LinearLabel {
  name: string;
}

export interface LinearUser {
  name: string;
  email: string;
}

export interface LinearBotActor {
  name: string;
  userDisplayName: string;
}

export interface LinearAttachement {
  url: string;
  sourceType: string;
}

export interface LinearIssueResponse {
  id: string;
  title: string;
  description: string;
  number: number;
  priority: number;
  estimate: number | null;
  state: {
    name: string;
  };
  identifier: string;
  team: {
    id: string;
    name: string;
  };
  project: {
    id: string;
    name: string;
  } | null;
  labels: LinearPaginatedResponse<LinearLabel>;
  creator: LinearUser | null;
  assignee: LinearUser | null;
  botActor: LinearBotActor | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  attachments: LinearPaginatedResponse<LinearAttachement>;
  comments: LinearPaginatedResponse<LinearComment>;
}

export interface LinearTeamResponse {
  id: string;
  name: string;
  key: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinearProject {
  id: string;
  name: string;
  description: string;
  teamId: string;
  state: string;
  startDate: string;
  targetDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: LinearUser | null;
  botActor: LinearBotActor | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncState {
  last_issue_sync: string;
  repository: string;
}

export interface IssueCommentSyncState {
  issue_id: bigint;
  last_comment_sync: string;
}

