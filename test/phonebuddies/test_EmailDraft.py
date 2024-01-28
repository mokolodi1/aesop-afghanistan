import unittest

from phonebuddies.EmailDraft import EmailDraft


class TestEmailDraft(unittest.TestCase):


    def test_remind_admins_contains_link(self):
        """
        Created to validate that this bug has been fixed: https://github.com/mokolodi1/aesop-afghanistan/issues/39
        """
        draft = EmailDraft.draft_overdue_process_admin_reminder("example@example.com")

        print(draft.contents) # XXX: remove before submitting PR
        self.assertTrue("https" in draft.contents)
