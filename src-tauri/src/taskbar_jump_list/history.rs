//! Pure recent-closed-tab history rules shared by persistence and Jump List generation.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_RECENT_CLOSED_TABS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentClosedTab {
    pub(crate) repository_name: String,
    pub(crate) root_path: String,
    pub(crate) relative_path: String,
    pub(crate) title: String,
}

pub(crate) fn remember(history: &mut Vec<RecentClosedTab>, entry: RecentClosedTab) {
    history.retain(|item| {
        item.root_path != entry.root_path || item.relative_path != entry.relative_path
    });
    history.insert(0, entry);
    history.truncate(MAX_RECENT_CLOSED_TABS);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(index: usize) -> RecentClosedTab {
        RecentClosedTab {
            repository_name: "repo".into(),
            root_path: "E:/repo".into(),
            relative_path: format!("note-{index}.md"),
            title: format!("note-{index}.md"),
        }
    }

    #[test]
    fn keeps_five_entries_and_moves_duplicate_to_the_front() {
        let mut history = (0..6).map(entry).collect::<Vec<_>>();
        history.clear();
        for index in 0..6 {
            remember(&mut history, entry(index));
        }
        assert_eq!(history.len(), MAX_RECENT_CLOSED_TABS);
        assert_eq!(history[0].relative_path, "note-5.md");
        assert_eq!(history[4].relative_path, "note-1.md");

        remember(&mut history, entry(2));
        assert_eq!(history[0].relative_path, "note-2.md");
        assert_eq!(history.len(), MAX_RECENT_CLOSED_TABS);
    }
}
