import logging
import traceback


class ResultTracker:
    """
    Allow for code anywhere to easily add to a growing list of issues found.
    These are not show-stoppers, but they should be reported to the admins in order
    to be corrected as soon as possible.
    """

    class Issue:
        def __init__(self, description, traceback_message=None) -> None:
            self.description = description
            self.traceback_message = traceback_message

    _instance = None

    @staticmethod
    def get_instance():
        if ResultTracker._instance is None:
            ResultTracker._instance = ResultTracker()

        return ResultTracker._instance

    def __init__(self):
        if ResultTracker._instance is not None:
            raise Exception("This class is a singleton!")
        
        self._issues = []
        self._result_description = "No result set. Usually this is an indication there was an error."

    @staticmethod
    def set_result(description):
        ResultTracker.get_instance()._result_description = description

    @staticmethod
    def add_issue(description, save_traceback=False):
        logging.warn("Issue found: %s", description)

        traceback_message = None
        if save_traceback is not None:
            traceback_message = traceback.format_exc()
            print(traceback_message)

        ResultTracker.get_instance()._issues.append(ResultTracker.Issue(description, traceback_message))

    @staticmethod
    def get_summary():
        """
        Returns a summary of the result of this run so far.
        """
        tracker = ResultTracker.get_instance()

        summary = "Result: %s" % tracker._result_description

        issues = tracker._issues
        if len(issues) > 0:
            summary += "\n\nFound %d issues:" % len(issues)

            for index, issue in enumerate(issues):
                # TODO: add four spaces before all lines in the issue text other than the first one
                # (so it's easy to see the issues)
                summary += "\n%d. %s" % (index + 1, issue.description)
        
        return summary
    
    @staticmethod
    def get_issues():
        return ResultTracker.get_instance()._issues
