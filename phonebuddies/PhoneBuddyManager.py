import datetime
import sys
import time
import click
from enum import Enum
import itertools
import logging

from phonebuddies.DatabaseConnector import DatabaseConnector
from phonebuddies.EmailDraft import EmailDraft
from phonebuddies.EmailSender import EmailSender
from phonebuddies.ResultTracker import ResultTracker

# XXX: need to fix this as part of: https://github.com/mokolodi1/aesop-afghanistan/issues/26
# There's no obvious, easy way to fix this in the general case in the short-term before we fix #26, so this hack will do.
ADMIN_EMAILS = ["email1@gmail.com", "email2@gmail.com"]
if 'unittest' not in sys.modules:
     with open("secrets/admin_emails.txt", mode="r") as admin_emails_file:
        ADMIN_EMAILS = list(set(itertools.chain(*[line.strip().split(",") for line in admin_emails_file.readlines()])))


class PhoneBuddyManager:
    """
    Manage the phone buddy list process and perform any necessary tasks each time it's run.
    """


    def __init__(self, really_send_emails, is_robot):
        self._really_send_emails = really_send_emails
        self._is_robot = is_robot

        self._db_connector = DatabaseConnector.get_instance()
        self._email_sender = EmailSender.get_instance()
        
        if self._really_send_emails:
            self._email_sender.enable_email_sending()

    
    def log_email_and_review(self, draft):
        logging.info("This is the first buddy pair, so we'll print a bit more info to allow for typechecking")
        logging.info("Draft: %s" % str(draft))
        logging.info("Email text:")
        logging.info("====================================")
        logging.info(draft.contents)
        logging.info("====================================")

        # Last check for the humans before sending the emails
        if not self._is_robot:
            if not self._really_send_emails:
                logging.info("Don't worry: emails won't actually be sent after the following questions!")

            click.confirm("Does the above email look good to send to everyone?")
            logging.info("Okay... well let's just make you wait for a few seconds (5) and see if you change your mind.")
            time.sleep(5)
            click.confirm('Are you still absolutely, positively sure?', abort=True, default=False)
            logging.info("Hmm, you seem quite sure of yourself, but let's wait another 5 seconds just in case.")
            time.sleep(5)
            click.confirm('Last chance to cancel! Still sure?', abort=True, default=False)
            logging.info("Okay, here we go!\n")


    def send_buddy_emails(self, buddy_pairs):
        buddy_map = self._db_connector.get_all_buddies_map()
        email_info = self._db_connector.get_email_info()

        # Verify humans really want to send the emails
        if self._really_send_emails and not self._is_robot:
            click.confirm(
                'You are about to send %s emails to phone buddy volunteers. Are you sure you want to continue?' %
                len(buddy_pairs), abort=True, default=False)

        # Actually go send the emails
        first_buddy_pair = True
        for buddy_pair in buddy_pairs:
            first_buddy = buddy_map[buddy_pair[0]]
            second_buddy = buddy_map[buddy_pair[1]]
            draft = EmailDraft.draft_buddies_email(email_info, first_buddy, second_buddy)

            if first_buddy_pair:
                first_buddy_pair = False
                self.log_email_and_review(draft)

            self._email_sender.send_email(draft)


    def send_admin_reminder_emails(self):
        # TODO: check whether we recently reminded them and don't remind them if it's happened within the last 24 hours
        # (https://github.com/mokolodi1/aesop-afghanistan/issues/23)
        for email in ADMIN_EMAILS:
            draft = EmailDraft.draft_overdue_process_admin_reminder(email)

            self._email_sender.send_email(draft)


    def admin_buddy_pairs(self):
        """
        Generate a list of buddy pairs from the admin emails
        """
        # TODO: fix this if there's a different number of admins than 2
        if len(ADMIN_EMAILS) != 2:
            ResultTracker.add_issue("Different number of admins than expected")

        return [ADMIN_EMAILS[:2]]

    def send_admins_without_buddy_emails(self , buddy_pairs):
        #extract a list of email addresses from buddy_pairs
        buddy_emails_list=[]
        for sublist in buddy_pairs:
            buddy_emails_list.extend(sublist)
        
        self.admins=ADMIN_EMAILS
        self.are_there_any_admins_without_buddies = False

        #only send to admins without buddies
        for email in self.admins:
            if email not in buddy_emails_list:
                self.are_there_any_admins_without_buddies = True
                draft = EmailDraft.draft_admins_without_buddy_emails(email)
                self._email_sender.send_email(draft)

        return(self.are_there_any_admins_without_buddies)
        
    def emails_sent_status(self):
        return "Yes" if self._really_send_emails else "Dry-run complete"

    def manage_phone_buddy_list(self):
        # Read in the database to check whether there's any issues
        buddy_pairs = []
        try:
            buddy_pairs = self._db_connector.get_buddy_email_pairs()

            # This is intentionally not accessed, but we want to get it so that we catch any issues
            self._db_connector.get_all_buddies()         
        except Exception as e:
            ResultTracker.add_issue("Error fetching the database: %s" % str(e), save_traceback=True)
        # Check whether we should send out any emails and then do that
        try:
            process = self._db_connector.get_this_weeks_process()
            if process.phone_buddy_emails_sent:
                ResultTracker.set_result("Phone buddy list already sent this week.")
            elif process.admin_email_sent:
                #send emails to admins without buddies
                self.send_admins_without_buddy_emails(buddy_pairs)
                if self.are_there_any_admins_without_buddies:
                    ResultTracker.set_result("One or more admins without buddies reminded")
                else: 
                    ResultTracker.set_result("All admins have buddies")
                self.send_buddy_emails(buddy_pairs)
                self._db_connector.update_process_buddies_emailed(process, self.emails_sent_status())
                ResultTracker.set_result("Phone buddy list sent")
            elif process.human_process_complete:
                self.send_buddy_emails(self.admin_buddy_pairs())
                self._db_connector.update_process_admins_emailed(process, self.emails_sent_status())
                ResultTracker.set_result("Admins emailed with trial email")
            else:
                self.send_admin_reminder_emails()
                ResultTracker.set_result("Admins reminded")

        except Exception as e:
            ResultTracker.add_issue("Error checking whether to and sending emails: %s" % str(e), save_traceback=True)

        # If any issues were found, report those
        # TODO: if the result was different from the last run (and it was a robot), add a new line to the output sheet
        # (https://github.com/mokolodi1/aesop-afghanistan/issues/24)

        logging.info("\n\n" + ResultTracker.get_summary())
        