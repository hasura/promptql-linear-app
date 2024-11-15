import { getDB, transaction } from "@hasura/ndc-duckduckapi";
import * as linear from "./linear";

/**
 * Linear implements rate limiting based on depth of the graphql requests.
 * See https://developers.linear.app/docs/graphql/working-with-the-graphql-api/rate-limiting
 * 
 * Hence I am avoiding fetching comments from a single GraphQL query on issue fetching.
 * Comments are fetched separately.
 * Since we fetch comments, only if the issue updatedAt is greater than last sync, 
 * it should reduce the request complexity and work within limits.
 * The limits resets in 1 hour, hence the re-sync is set at 61 minutes.
 * Also, on the next sync cycle, it will first sync teams that didn't got touched in the last cycle first (in case we still are hitting limits)
*/
export class LinearSyncManager {
  private url = 'https://api.linear.app/graphql';
  private token: string = '';
  private syncInterval: NodeJS.Timeout | null = null;

  constructor() {
    console.log(`Initializing Linear sync`);
  }

  private async linearFetch(query: string): Promise<any> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        'Authorization': `${this.token}`,
        'User-Agent': 'Linear-Issue-Sync',
        "Content-Type": "application/json"
      },
      body: query
    });

    if (!response.ok) {
      const error = await response.text().catch(() => null);
      throw new Error(`Linear API error (${response.status}): ${error}`);
    }
    return response.json();
  }

  async initialize(token: string): Promise<boolean> {
    try {

      console.log("Last sync status:" + await this.getSyncStatus())

      console.log('Starting initialization...');
      this.token = token;
      
      // Validate token by fetching user info
      console.log('Validating Linear token: ...');
      const query = "query Me { viewer { id } }";
      await this.linearFetch(JSON.stringify({query: query}));
      console.log('Token validation successful');

      // Start initial sync
      console.log('Starting initial sync...');
      await this.syncIssuesAndComments();
      console.log('Initial sync complete');
      
      // Set up continuous sync
      console.log('Setting up continuous sync (1 hour interval)...');
      this.syncInterval = setInterval(() => this.syncIssuesAndComments(), 61 * 60 * 1000);
      
      return true;
    } catch (error) {
      console.error('Initialization failed:', error);
      return false;
    }
  }

  private async syncIssuesAndComments(): Promise<void> {
    try {
      console.log('Starting sync cycle...');
      const db = await getDB();

      // Start initial sync
      console.log('Starting team sync...');
      const teams = await this.syncTeams();
      console.log('Team sync complete');

      for (const team of teams) {
        const lastSync = await this.getLastIssueSyncState(team.id);
        console.log(`Last issue sync for team ${team.name}: ${lastSync || 'never'}`);  
        console.log(`Syncing issues for team ${team.name} since ${lastSync || 'the beginning'}`);
  
        const issues = await this.fetchAllIssues(team.id, lastSync);
        console.log(`Fetched ${issues.length} issues for team: ${team.name}`);
        
        await this.saveIssues(issues, lastSync)
        await this.updateIssueSyncState(team.id);

        for (const issue of issues) {
          await this.syncCommentsForIssue(issue);
          await this.syncHistoryForIssue(issue);
        }
      }
      
    } catch (error) {
      console.error('Sync cycle failed:', error);
    }
  }
  
  private async syncCommentsForIssue(issue: linear.LinearIssueResponse) {
    const lastCommentSync = await this.getCommentSyncState(issue.id, issue.identifier);
          
    const needsCommentSync = !lastCommentSync || 
        new Date(issue.updatedAt) > new Date(lastCommentSync);

    if (needsCommentSync) {
      console.log(`Syncing comments for issue #${issue.identifier}`);

      const comments = await this.fetchComments(
        issue.id,
        lastCommentSync || undefined
      );
      await this.saveComments(comments, issue.id, issue.identifier);
      await this.updateCommentSyncState(issue.id, issue.identifier);
    }
  }

  private async syncHistoryForIssue(issue: linear.LinearIssueResponse) {
    const lastHistorySync = await this.getHistorySyncState(issue.id, issue.identifier);
          
    const needsHistorySync = !lastHistorySync || 
        new Date(issue.updatedAt) > new Date(lastHistorySync);

    if (needsHistorySync) {
      console.log(`Syncing history for issue #${issue.identifier}`);
      const history = await this.fetchHistory(issue.id);
      await this.saveHistory(history, issue.id, issue.identifier, issue.createdAt);
      await this.updateHistorySyncState(issue.id, issue.identifier);
    }
  }

  public async syncTeams(): Promise<linear.LinearTeamResponse[]> {
    const db = await getDB();
    try {
      const teams = await this.fetchTeams();
      await transaction(db, async (tx) => {
        for (const team of teams) {
          await tx.run(`
            INSERT INTO linear_teams (
              id,
              name,
              key,
              description,
              created_at,
              updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              key = excluded.key,
              description = excluded.description,
              updated_at = excluded.updated_at
          `,
            team.id,
            team.name,
            team.key,
            team.description,
            new Date(team.createdAt),
            new Date(team.updatedAt)
          );

          // Update sync state for this team
          await tx.run(`
            INSERT INTO linear_sync_state (
              team_id,
              last_issue_sync
            ) VALUES (
              ?, NULL
            )
            ON CONFLICT(team_id) DO NOTHING
          `, [team.id]);
        }
      });

      // reverse order by teams in terms of last sync state
      const orderedTeams : linear.LinearTeamResponse[] = []
      try {
        const result = await db.all(`
          SELECT team_id
          FROM linear_sync_state
          ORDER BY last_issue_sync ASC NULLS FIRST`);
        for (const row of result) {
          const found = teams.find(function(value) {
            return (value.id == row.team_id);
          })
          if(found) {
            orderedTeams.push(found)
          }
        }
      } catch (error) {
        console.error('Failed to get issue sync state:', error);
        throw error;
      }
      return orderedTeams;
    } catch (error) {
      console.error('Failed to fetch and sync teams:', error);
      throw error;
    }
  }

  private async fetchTeams(): Promise<linear.LinearTeamResponse[]> {
    let hasNextPage = true;
    let cursor: string | undefined;
    const teams : linear.LinearTeamResponse[] = [];
    while (hasNextPage) {
      const response = await this.linearFetch(JSON.stringify({
        query: linear.teamsQuery, 
        variables: {
          after: cursor || null,
        }
      })) 
      teams.push(...response.data.teams.nodes)
      hasNextPage = response.data.teams.pageInfo.hasNextPage;
      cursor = response.data.teams.pageInfo.endCursor;
    }
    return teams;
  }

  private async getLastIssueSyncState(team: string): Promise<string | undefined> {
    const db = await getDB();
    try {
      const result = await db.all(`
        SELECT last_issue_sync
        FROM linear_sync_state
        WHERE team_id = ?`,
        [team]);
        return result.length > 0 ? result[0].last_issue_sync : null;
    } catch (error) {
      console.error('Failed to get issue sync state:', error);
      throw error;
    }
  }

  private async getCommentSyncState(issueId: string, issueReadableId: string): Promise<string | null> {
    const db = await getDB();
    try {
      const result = await db.all(
        `SELECT last_comment_sync 
         FROM linear_comment_sync_state 
         WHERE issue_id = ?`,
        issueId
      );
      return result.length > 0 ? result[0].last_comment_sync : null;
    } catch (error) {
      console.error(`Failed to get comment sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async getHistorySyncState(issueId: string, issueReadableId: string): Promise<string | null> {
    const db = await getDB();
    try {
      const result = await db.all(
        `SELECT last_history_sync 
         FROM linear_history_sync_state 
         WHERE issue_id = ?`,
        issueId
      );
      return result.length > 0 ? result[0].last_history_sync : null;
    } catch (error) {
      console.error(`Failed to get issue history sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async updateIssueSyncState(team: string): Promise<void> {
    try {
    const db = await getDB();
      await transaction(db, async (conn) => {
        await conn.run(`
          INSERT INTO linear_sync_state (team_id, last_issue_sync)
          VALUES (?, ?)
          ON CONFLICT(team_id) DO UPDATE SET last_issue_sync = ?
        `, team, new Date().toISOString(), new Date().toISOString());
      });
      console.log('Issue sync state updated');
    } catch (error) {
      console.error('Failed to update issue sync state:', error);
      throw error;
    }
  }

  private async updateCommentSyncState(issueId: string, issueReadableId: string): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (conn) => {
        await conn.run(`
          INSERT INTO linear_comment_sync_state (issue_id, last_comment_sync)
          VALUES (?, ?)
          ON CONFLICT(issue_id) DO UPDATE SET last_comment_sync = ?
        `, issueId, new Date().toISOString(), new Date().toISOString());
      });
      console.log(`Comment sync state updated for issue ${issueReadableId}`);
    } catch (error) {
      console.error(`Failed to update comment sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async updateHistorySyncState(issueId: string, issueReadableId: string): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (conn) => {
        await conn.run(`
          INSERT INTO linear_history_sync_state (issue_id, last_history_sync)
          VALUES (?, ?)
          ON CONFLICT(issue_id) DO UPDATE SET last_history_sync = ?
        `, issueId, new Date().toISOString(), new Date().toISOString());
      });
      console.log(`History sync state updated for issue ${issueReadableId}`);
    } catch (error) {
      console.error(`Failed to update history sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async fetchAllIssues(teamId: string, since?: string): Promise<linear.LinearIssueResponse[]> {
    let hasNextPage = true;
    let cursor: string | undefined;
    const issues : linear.LinearIssueResponse[] = [];
    while (hasNextPage) {

      const response = await this.linearFetch(JSON.stringify({
        query: linear.issuesQuery, 
        variables: {
          teamId,
          after: cursor || null,
          filter: since ? {updatedAt: {gte: since}} : null
        }
      })) 
       
      issues.push(...response.data.team.issues.nodes)
      hasNextPage = response.data.team.issues.pageInfo.hasNextPage;
      cursor = response.data.team.issues.pageInfo.endCursor;
    }
    
    return issues
  }

  private async fetchComments(issueId: string, since?: string): Promise<linear.LinearComment[]> {
    let hasNextPage = true;
    let cursor: string | undefined;
    const comments : linear.LinearComment[] = [];
    while (hasNextPage) {

      const response = await this.linearFetch(JSON.stringify({
        query: linear.commentsQuery, 
        variables: {
          after: cursor || null,
          filter: since ? {
            and: [
              { updatedAt: {gte: since} }, 
              { 
                issue: {
                  id: {
                    eq: issueId
                  }
                }
              }
            ]
          } : { 
            issue: {
              id: {
                eq: issueId
              }
            }
          }
        }
      })) 
       
      comments.push(...response.data.comments.nodes)
      hasNextPage = response.data.comments.pageInfo.hasNextPage;
      cursor = response.data.comments.pageInfo.endCursor;
    }
    
    return comments
  }

  private async fetchHistory(issueId: string): Promise<linear.IssueHistory[]> {
    let hasNextPage = true;
    let cursor: string | undefined;
    const history : linear.IssueHistory[] = [];
    while (hasNextPage) {

      const response = await this.linearFetch(JSON.stringify({
        query: linear.issueHistoryQuery, 
        variables: {
          issueId: issueId,
          after: cursor || null,
          first: 5,
          orderBy: "createdAt"
        }
      })) 
       
      history.push(...response.data.issue.history.nodes)
      hasNextPage = response.data.issue.history.pageInfo.hasNextPage;
      cursor = response.data.issue.history.pageInfo.endCursor;
    }
    
    return history
  }

  private async saveIssues(issues: linear.LinearIssueResponse[], lastSync: string | undefined): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (tx) => {
        for (const issue of issues) {
          // Skip issues that haven't been updated since last sync
          if (lastSync && new Date(issue.updatedAt) <= new Date(lastSync)) {
            continue;
          }

          const labelString = issue.labels.nodes
            .map(label => label.name)
            .join(',');

          await tx.run(`
            INSERT INTO linear_issues (
              id, team_id, title, description,
              state, priority, number, identifier, created_at, updated_at,
              completed_at, creator_email, creator_name, assignee_email,
              assignee_name, bot_type, bot_user, link_type, link_url,
              labels
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?
            )
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              state = excluded.state,
              priority = excluded.priority,
              identifier = excluded.identifier,
              updated_at = excluded.updated_at,
              completed_at = excluded.completed_at,
              assignee_email = excluded.assignee_email,
              assignee_name = excluded.assignee_name,
              link_type = excluded.link_type,
              link_url = excluded.link_url,
              labels = excluded.labels
          `,
            issue.id,
            issue.team.id,
            issue.title,
            issue.description,
            issue.state.name,
            issue.priority,
            issue.number,
            issue.identifier,
            new Date(issue.createdAt),
            new Date(issue.updatedAt),
            issue.completedAt ? new Date(issue.completedAt) : null,
            issue.creator? issue.creator.email : null,
            issue.creator? issue.creator.name : null,
            issue.assignee? issue.assignee.email : null,
            issue.assignee? issue.assignee.name : null,
            issue.botActor? issue.botActor.name : null,
            issue.botActor? issue.botActor.userDisplayName : null,
            issue.attachments && issue.attachments.nodes.length > 0 ?  issue.attachments.nodes[0].sourceType : null,
            issue.attachments && issue.attachments.nodes.length > 0 ?  issue.attachments.nodes[0].url : null,
            issue.labels && issue.labels.nodes.length > 0 ? JSON.stringify(issue.labels.nodes.map(l => l.name).join(',')) : null
          );
        }
      });
      console.log(`Saved ${issues.length} issues to database`);
    } catch (error) {
      console.error('Failed to save issues:', error);
      throw error;
    }
  }

  private async saveComments(comments: linear.LinearComment[], issueId: string, issueReadableId: string): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (conn) => {
        // If this is a full sync, clear existing comments
        const lastSync = await this.getCommentSyncState(issueId, issueReadableId);
        if (!lastSync) {
          console.log(`Performing full comment sync for issue ID ${issueId}, clearing existing comments...`);
          await conn.run(
            `DELETE FROM linear_comments WHERE issue_id = ?`,
            issueId,
          );
        }

        // Insert or update new comments
        for (const comment of comments) {
          await conn.run(`
            INSERT OR REPLACE INTO linear_comments (
              id, issue_id, body, user_email, user_name, bot_type, bot_user, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          comment.id,
          issueId,
          comment.body,
          comment.user? comment.user.email : null,
          comment.user? comment.user.name : null,
          comment.botActor? comment.botActor.name: null,
          comment.botActor? comment.botActor.userDisplayName: null,
          new Date(comment.createdAt),
          new Date(comment.updatedAt),
          );
        }
      });
      console.log(`Saved ${comments.length} comments for issue ID ${issueReadableId}`);
    } catch (error) {
      console.error(`Failed to save comments for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async saveHistory(history: linear.IssueHistory[], issueId: string, issueReadableId: string, createdAt: string): Promise<void> {
    try {
      let backlogCreatedAt: string | undefined;
      let backlogCompletedAt: string | undefined;
      let triageCreatedAt: string | undefined;
      let triageCompletedAt: string | undefined;
      let todoCreatedAt: string | undefined;
      let todoCompletedAt: string | undefined;
      let inprogressCreatedAt: string | undefined;
      let inprogressCompletedAt: string | undefined;
      let reviewCreatedAt: string | undefined;
      let reviewCompletedAt : string | undefined;
      let blockedCreatedAt: string | undefined;
      let blockedCompletedAt: string | undefined;

      function setStateDate(state : string | null, updatedAt: string, isFrom: boolean) {
        if (state == null) {
          return
        }
        if(state == "Backlog") {
          // Why !backlogCompletedAt ?
          // An issue can be moved to a state any number of times. 
          // Since the data is ordered from latest state change; ignore older occurrences of state completion.
          if(isFrom && !backlogCompletedAt) {
            backlogCompletedAt = updatedAt;
          }
          else {
            backlogCreatedAt = updatedAt;
          }
        }
        if(state == "Triage") {
          if(isFrom && !triageCompletedAt) {
            triageCompletedAt = updatedAt;
          }
          else {
            triageCreatedAt = updatedAt;
          }
        }
        if(state == "Todo") {
          if(isFrom && !todoCompletedAt) {
            todoCompletedAt = updatedAt;
          }
          else {
            todoCreatedAt = updatedAt;
          }
        }
        if(state == "In Progress") {
          if(isFrom && !inprogressCompletedAt) {
            inprogressCompletedAt = updatedAt;
          }
          else {
            inprogressCreatedAt = updatedAt;
          }
        }
        if(state == "In Review") {
          if(isFrom && !reviewCompletedAt) {
            reviewCompletedAt = updatedAt;
          }
          else {
            reviewCreatedAt = updatedAt;
          }
        }
        if(state == "Blocked") {
          if(isFrom && !blockedCompletedAt) {
            blockedCompletedAt = updatedAt;
          }
          else {
            blockedCreatedAt = updatedAt;
          }
        }
      };

      for (const change of history) {
        setStateDate(change.toState ? change.toState.name : null, change.createdAt, false);
        setStateDate(change.fromState ? change.fromState.name : null, change.createdAt, true);
      }
      // Generally issues are created in Backlog, Triage or Todo state. The state in which issue is created is not captured in history.
      // If these states have completion date but no created date. set the creation date for the state with issue creation date
      if(backlogCompletedAt && !backlogCreatedAt) {
        backlogCreatedAt = createdAt;
      }
      else if(triageCompletedAt && !triageCreatedAt) {
        triageCreatedAt = createdAt;
      }
      else if(todoCompletedAt && !todoCreatedAt) {
        todoCreatedAt = createdAt;
      }

      const db = await getDB();
      await transaction(db, async (tx) => {
        await tx.run(`
          UPDATE linear_issues SET 
            state_backlog_created_at = ?,
            state_backlog_completed_at = ?,
            state_triage_created_at = ?,
            state_triage_completed_at = ?,
            state_todo_created_at = ?,
            state_todo_completed_at = ?,
            state_inprogress_created_at = ?,
            state_inprogress_completed_at = ?,
            state_review_created_at = ?,
            state_review_completed_at = ?,
            state_blocked_created_at = ?,
            state_blocked_completed_at = ?
          WHERE id = ?
        `,
          backlogCreatedAt ? new Date(backlogCreatedAt): null,
          backlogCompletedAt ? new Date(backlogCompletedAt): null,
          triageCreatedAt ? new Date(triageCreatedAt): null,
          triageCompletedAt ? new Date(triageCompletedAt): null,
          todoCreatedAt ? new Date(todoCreatedAt): null,
          todoCompletedAt ? new Date(todoCompletedAt): null,
          inprogressCreatedAt ? new Date(inprogressCreatedAt): null,
          inprogressCompletedAt ? new Date(inprogressCompletedAt): null,
          reviewCreatedAt ? new Date(reviewCreatedAt): null,
          reviewCompletedAt ? new Date(reviewCompletedAt): null,
          blockedCreatedAt ? new Date(blockedCreatedAt): null,
          blockedCompletedAt ? new Date(blockedCompletedAt): null,
          issueId
        );
      });
      console.log(`Saved state history for issue ID ${issueReadableId}`);
    } catch (error) {
      console.error('Failed to save issue history:', error);
      throw error;
    }
  }

  public async getIssueComments(issueId: string): Promise<any[]> {
    try {
      const db = await getDB();
      return await db.all(`
        SELECT * 
        FROM linear_comments
        WHERE issue_id = ?
        ORDER BY c.created_at ASC
      `, issueId,);
    } catch (error) {
      console.error(`Failed to get comments for issue #${issueId}:`, error);
      throw error;
    }
  }

  public async getSyncStatus(): Promise<string> {
    try {
      const db = await getDB();
      const teams = await db.all(`
        SELECT id, name
        FROM linear_teams`);
      
      let result = ""
      for (const team of teams) {
        const issueSync = await this.getLastIssueSyncState(team.id);
        const repoStats = await db.all(`
          SELECT 
            COUNT(DISTINCT id) as total_issues,
          FROM linear_issues
          WHERE team_id = ?
        `, team.id);
        result = result + "\nTeam " + team.name + ", total issues: " + repoStats[0].total_issues + ", last synced: " + issueSync;
      }
  
      return result;
    } catch (error) {
      console.error('Failed to get sync status:', error);
      throw error;
    }
  }

  public stop(): void {
    if (this.syncInterval) {
      console.log('Stopping sync process...');
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Sync process stopped');
    }
  }

  public async cleanup(): Promise<void> {
    try {
      const db = await getDB();
      console.log('Starting cleanup process...');
      await transaction(db, async (conn) => {
        // Remove all data for this repository
        await conn.run(
          `DELETE FROM linear_comments`
        );
        await conn.run(
          `DELETE FROM linear_issues`
        );
        await conn.run(
          `DELETE FROM linear_sync_state`
        );
        await conn.run(
          `DELETE FROM linear_comment_sync_state`
        );
      });
      console.log('Cleanup complete');
    } catch (error) {
      console.error('Failed to cleanup repository data:', error);
      throw error;
    }
  }
}